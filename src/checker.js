// Moteur de contrôle : un passage = HTTP + contenu + DNS + TLS + RDAP, comparé à l'état précédent.
//
// Deux familles de signaux :
//  • incidents  — états anormaux persistants (site down, mot-clé de piratage, certificat expiré…).
//                 Alerte à l'apparition, message « rétabli » à la disparition.
//  • évènements — changements ponctuels (contenu, DNS, certificat, scripts…). Alerte une fois,
//                 la nouvelle valeur devient la référence.
//
// Les pannes confirmées (N échecs consécutifs) sont en plus enregistrées comme périodes d'indisponibilité,
// d'où est calculée la disponibilité.
import dnsP from 'node:dns/promises';
import tls from 'node:tls';
import {
  getWatch, settingsFor, saveRun, insertSnapshot, latestSnapshot, snapshotLines, insertCheck, insertAlert, markNotified,
  prune, openOutage, closeOutage, upsertDaily, activeMaintenance, pendingMaintenanceAlerts, markMaintenanceSummarized,
} from './db.js';
import { cmsIncidents, cmsIncidentGroup } from './cms-alerts.js';
import { resolvePage, pageName } from './pages.js';
import { parseHtml, selectAll, textLines, extractFeatures } from './html.js';
import { diffLines, preview } from './diff.js';
import { eligibleFor } from './notify.js';
import { getExtensions } from './extensions.js';
import { captureWatch, engine } from './screenshot.js';
import { bus } from './events.js';
import { sha1, registrable, isIp, SEV, fmtDuration } from './util.js';

const MAX_BODY = 5 * 1024 * 1024;
const RDAP_EVERY = 3600e3; // un détournement de domaine doit être vu vite : toutes les heures
const DAY = 86400e3;

// ───────────── HTTP ─────────────

export function describeError(e) {
  const code = e?.cause?.code || e?.code || e?.name;
  const map = {
    ENOTFOUND: ['Nom de domaine introuvable (DNS)'],
    EAI_AGAIN: ['Résolution DNS indisponible'],
    ECONNREFUSED: ['Connexion refusée par le serveur'],
    ECONNRESET: ['Connexion interrompue par le serveur'],
    EHOSTUNREACH: ['Serveur injoignable'],
    ENETUNREACH: ['Réseau injoignable'],
    ETIMEDOUT: ['Délai de connexion dépassé'],
    UND_ERR_CONNECT_TIMEOUT: ['Délai de connexion dépassé'],
    UND_ERR_HEADERS_TIMEOUT: ['Le serveur ne répond pas (en-têtes)'],
    TimeoutError: ['Délai dépassé'],
    AbortError: ['Délai dépassé'],
    CERT_HAS_EXPIRED: ['Certificat TLS expiré', true],
    DEPTH_ZERO_SELF_SIGNED_CERT: ['Certificat TLS auto-signé', true],
    SELF_SIGNED_CERT_IN_CHAIN: ['Certificat TLS auto-signé dans la chaîne', true],
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['Certificat TLS non vérifiable (chaîne incomplète)', true],
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: ['Certificat TLS : émetteur inconnu', true],
    ERR_TLS_CERT_ALTNAME_INVALID: ['Le certificat TLS ne correspond pas au domaine', true],
    ERR_SSL_WRONG_VERSION_NUMBER: ['Erreur de protocole TLS'],
    UND_ERR_SOCKET: ['Connexion coupée par le serveur sans réponse'],
    REDIRECT_LOOP: ['Boucle ou excès de redirections'],
    ESSRF: ['Adresse non autorisée : réseau privé ou interne'], // garde réseau (src/net-guard.js)
    BODY_TOO_LARGE: ['Page trop volumineuse'],
  };
  const m = map[code];
  // « fetch failed » ne dit rien : la vraie cause est dans error.cause.
  const generic = e?.message === 'fetch failed' ? e?.cause?.message || e?.cause?.code : e?.message;
  return { code, message: m ? m[0] : generic || String(e), tls: !!m?.[1] };
}

function decodeBody(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

async function readBody(res) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchPage(startUrl, cfg, settings) {
  const guard = getExtensions().netGuard; // inerte par défaut : fetch() d'origine
  const jar = new Map();
  const chain = [];
  let cur = startUrl;
  const t0 = performance.now();
  let ttfb = 0;
  for (let hop = 0; hop <= 10; hop++) {
    const headers = {
      'user-agent': cfg.userAgent || settings.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'fr-FR,fr;q=0.9,en;q=0.7',
      ...cfg.headers,
    };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    // Chaque étape d'une redirection est vérifiée comme la première : une adresse publique peut renvoyer vers une adresse interne.
    const res = await guard.fetch(cur, { redirect: 'manual', headers, signal: AbortSignal.timeout(cfg.timeoutS * 1000) });
    if (!ttfb) ttfb = Math.round(performance.now() - t0);
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const kv = sc.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    chain.push({ url: cur, status: res.status });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      cur = new URL(loc, cur).href;
      continue;
    }
    const buf = await readBody(res);
    const contentType = res.headers.get('content-type') || '';
    return {
      status: res.status,
      finalUrl: cur,
      chain,
      ms: Math.round(performance.now() - t0),
      ttfb,
      size: buf.length,
      contentType,
      server: res.headers.get('server') || '',
      poweredBy: res.headers.get('x-powered-by') || '',
      buf,
      body: /html|xml|json|text|javascript/i.test(contentType) || !contentType ? decodeBody(buf, contentType) : null,
    };
  }
  throw Object.assign(new Error('redirects'), { code: 'REDIRECT_LOOP' });
}

// ───────────── Analyse du contenu ─────────────

function compileRegexes(list) {
  const out = [];
  for (const s of list) {
    try {
      out.push(new RegExp(s, 'i'));
    } catch {
      /* ignoré : validé à l'enregistrement */
    }
  }
  return out;
}

export function analyze(page, cfg) {
  const isHtml = /html/i.test(page.contentType) || (page.body && /<html|<!doctype html|<body/i.test(page.body.slice(0, 2000)));
  let lines = [];
  let fullLines = [];
  let features = null;
  let selectorMissing = false;

  if (page.body === null) {
    return { lines, fullLines, features, hash: sha1(page.buf), binary: true, title: '' };
  }
  if (isHtml) {
    const root = parseHtml(page.body);
    features = extractFeatures(root, page.finalUrl);
    fullLines = textLines([root], { images: cfg.images });
    let scope = [root];
    if (cfg.selector) {
      const found = selectAll(root, cfg.selector);
      if (found.length) scope = found;
      else selectorMissing = true;
    }
    const exclude = cfg.excludeSelector ? new Set(selectAll(root, cfg.excludeSelector)) : null;
    lines = cfg.selector || exclude ? textLines(selectorMissing ? [] : scope, { exclude, images: cfg.images }) : fullLines;
  } else {
    lines = page.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    fullLines = lines;
  }
  const res = compileRegexes(cfg.ignoreRegex);
  if (res.length) lines = lines.filter((l) => !res.some((r) => r.test(l)));
  return { lines, fullLines, features, hash: sha1(lines.join('\n')), title: features?.title || '', selectorMissing };
}

/**
 * Position d'un mot ou d'une expression ENTIÈRE dans un texte.
 * Évite les faux positifs par sous-chaîne : « cialis » ne doit pas être trouvé dans « spécialisées ».
 */
export function wordIndex(hay, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return hay.search(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u'));
}

const context = (hay, needle) => {
  const i = wordIndex(hay, needle);
  if (i < 0) return '';
  return '…' + hay.slice(Math.max(0, i - 50), i + needle.length + 70).replace(/\s+/g, ' ') + '…';
};

// ───────────── DNS / TLS / RDAP ─────────────

const cleanList = (arr) => arr.map((x) => String(x).toLowerCase().replace(/\.$/, '')).filter(Boolean).sort();

/** Serveurs de noms de la zone qui contient `host` (on remonte vers le parent jusqu'à trouver des NS). */
async function nsOf(resolver, host) {
  let h = host;
  while (h.includes('.')) {
    try {
      const ns = await resolver.resolveNs(h);
      if (ns.length) return { ns: cleanList(ns), zone: h };
    } catch {
      /* on remonte vers le parent */
    }
    h = h.split('.').slice(1).join('.');
  }
  return { ns: [], zone: '' };
}

/** Résolveurs publics interrogés en parallèle : un détournement ou un cache empoisonné donne des réponses divergentes. */
const PUBLIC_RESOLVERS = { Cloudflare: '1.1.1.1', Google: '8.8.8.8', Quad9: '9.9.9.9' };

export async function lookupDns(host) {
  const r = new dnsP.Resolver({ timeout: 4000, tries: 2 });
  const out = { a: [], aaaa: [], cname: [], ns: [], mx: [], spf: '', dmarc: '', caa: [], zone: '', resolvers: {} };
  const txt = async (name) => {
    try {
      return (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch {
      return [];
    }
  };
  await Promise.all([
    r.resolve4(host).then((v) => (out.a = cleanList(v)), () => {}),
    r.resolve6(host).then((v) => (out.aaaa = cleanList(v)), () => {}),
    r.resolveCname(host).then((v) => (out.cname = cleanList(v)), () => {}),
  ]);
  const z = await nsOf(r, host);
  out.ns = z.ns;
  out.zone = z.zone;
  const apex = z.zone || registrable(host);
  const [mx, apexTxt, dmarcTxt, caa, pub] = await Promise.all([
    r.resolveMx(apex).then((v) => cleanList(v.map((m) => m.exchange)), () => []),
    txt(apex),
    txt(`_dmarc.${apex}`),
    r.resolveCaa(apex).then((v) => v.map((c) => Object.entries(c).filter(([k]) => k !== 'critical').map(([k, val]) => `${k} ${val}`).join(' ')).sort(), () => []),
    Promise.all(Object.entries(PUBLIC_RESOLVERS).map(async ([name, ip]) => {
      const rr = new dnsP.Resolver({ timeout: 2500, tries: 1 });
      rr.setServers([ip]);
      return [name, (await nsOf(rr, host).catch(() => ({ ns: [] }))).ns];
    })),
  ]);
  out.mx = mx;
  out.spf = apexTxt.find((t) => /^v=spf1/i.test(t)) || '';
  out.dmarc = dmarcTxt.find((t) => /^v=dmarc1/i.test(t)) || '';
  out.caa = caa;
  out.resolvers = Object.fromEntries(pub.filter(([, ns]) => ns.length));
  return out;
}

const ipPrefix = (ip) => (ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.'));

export function tlsInfo(host, port = 443, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const guard = getExtensions().netGuard;
    try {
      guard.checkUrl(`https://${host.includes(':') ? `[${host}]` : host}:${port}`); // port et adresse écrite telle quelle
    } catch (e) {
      return reject(e);
    }
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, lookup: guard.lookup }, () => {
      const c = sock.getPeerCertificate();
      resolve({
        fp: c.fingerprint256 || '',
        issuer: c.issuer?.O || c.issuer?.CN || '',
        subject: c.subject?.CN || '',
        validTo: c.valid_to,
        expires: Date.parse(c.valid_to),
        authorized: sock.authorized,
        authError: sock.authorizationError ? String(sock.authorizationError.message || sock.authorizationError) : '',
        protocol: sock.getProtocol(),
      });
      sock.end();
    });
    sock.setTimeout(timeout, () => {
      sock.destroy();
      reject(new Error('Délai TLS dépassé'));
    });
    sock.on('error', reject);
  });
}

async function rdapFetch(domain) {
  const res = await fetch(`https://rdap.org/domain/${domain}`, {
    headers: { accept: 'application/rdap+json', 'user-agent': 'VigieWeb/1.0 (surveillance de noms de domaine)' },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) return { unsupported: true };
  if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`);
  const j = await res.json();
  const registrar = j.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((x) => x[0] === 'fn')?.[3] || '';
  const ev = (a) => Date.parse(j.events?.find((e) => e.eventAction === a)?.eventDate) || 0;
  const status = (j.status || []).map((s) => s.toLowerCase());
  return {
    registrar,
    registered: ev('registration'),
    expires: ev('expiration'),
    transferred: ev('transfer'),
    changed: ev('last changed'),
    locked: status.some((s) => /transfer prohibited/.test(s)),
    status,
    nameservers: cleanList((j.nameservers || []).map((n) => n.ldhName || '')),
    dnssec: typeof j.secureDNS?.delegationSigned === 'boolean' ? j.secureDNS.delegationSigned : null,
  };
}

// Plusieurs sites d'un même domaine partagent une seule requête (le registre limite le débit).
const rdapCache = new Map();
export function rdapLookup(domain) {
  const hit = rdapCache.get(domain);
  if (hit && Date.now() - hit.ts < 30 * 60e3) return hit.p;
  const p = rdapFetch(domain);
  rdapCache.set(domain, { ts: Date.now(), p });
  p.catch(() => rdapCache.delete(domain));
  return p;
}

/** Points d'entrée réseau, remplaçables dans les tests. */
export const hooks = { fetchPage, lookupDns, tlsInfo, rdapLookup };

// ───────────── Passage complet ─────────────

const catOf = (key) => {
  const b = key.split(':')[0];
  if (['down', 'http', 'downgrade'].includes(b)) return 'net';
  if (b.startsWith('tls')) return 'tls';
  if (b.startsWith('cms') || b === 'php_eol') return 'cms';
  if (b.startsWith('page_')) return 'pages';
  if (b.startsWith('rdap')) return 'rdap';
  if (b.startsWith('dns')) return 'dns';
  return 'content';
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dateFr = (t) => new Date(t).toLocaleDateString('fr-FR');

/** Erreur « site en panne » : toute erreur HTTP sauf les accès restreints (401/403/429 = serveur joignable). */
const isDownCode = (code) => code >= 400 && ![401, 403, 429].includes(code);

/** Statuts RDAP signalant un transfert en cours, une suspension ou une expiration du domaine. */
const RISKY_STATUS = /pending transfer|hold|redemption|pending delete|pending restore/;

export async function runCheck(id) {
  const w = await getWatch(id);
  if (!w) return null;
  const settings = await settingsFor(w.accountId); // installation + réglages du compte du site
  const cfg = w.config;
  const c = cfg.checks;
  const domainOnly = cfg.mode === 'domain';
  const now = Date.now();
  const state = { incidents: {}, fails: 0, ...w.state };
  const first = !state.baseline;
  const url = new URL(w.url);
  const host = url.hostname;
  const domain = registrable(host);
  // Fenêtre de maintenance en cours : les alertes sont retenues et aucune panne n'est comptée (voir plus bas).
  const maint = await activeMaintenance(w.id, now);

  // Pages supplémentaires (panier, contact, connexion) : récupérées en parallèle du reste du passage.
  const extra = domainOnly ? [] : (cfg.pages || []).map((p) => ({ p, href: resolvePage(w.url, p) })).filter((x) => x.href);
  const extraJob = extra.length ? Promise.allSettled(extra.map((x) => hooks.fetchPage(x.href, cfg, settings))) : null;

  const rdapDue = c.rdap && !isIp(host) && domain.includes('.') && (!state.rdap || now - (state.rdap.checkedAt || 0) > (state.rdap.unsupported ? 7 * DAY : RDAP_EVERY));
  const none = () => Promise.reject(null);
  const [pageR, dnsR, tlsR, rdapR] = await Promise.allSettled([
    domainOnly ? none() : hooks.fetchPage(w.url, cfg, settings),
    c.dns && !isIp(host) ? hooks.lookupDns(host) : none(),
    !domainOnly && c.tls && url.protocol === 'https:' ? hooks.tlsInfo(host, Number(url.port) || 443) : none(),
    rdapDue ? hooks.rdapLookup(domain) : none(),
  ]);

  const alerts = [];
  const incidents = {};
  const evaluated = new Set();
  const add = (type, severity, title, detail = '', extra = {}) => alerts.push({ type, severity, title, detail, ...extra });
  const inc = (key, severity, title, detail = '', count = null) => (incidents[key] = { severity, title, detail, ...(count != null ? { count } : {}) });
  const baseline = !first; // les évènements de changement ne sont émis qu'à partir du 2e passage

  let code = null;
  let ms = null;
  let size = null;
  let error = null;
  let hash = null;
  let snapshotId = null;
  let down = false;
  let closedOutage = null;

  // ── Disponibilité : un passage est « en panne » si le site ne répond pas ou renvoie une vraie erreur HTTP ──
  let page = null;
  let pageErr = null;
  if (!domainOnly) {
    if (pageR.status === 'rejected') {
      pageErr = describeError(pageR.reason);
      error = pageErr.message;
      down = true;
    } else {
      page = pageR.value;
      code = page.status;
      ms = page.ms;
      size = page.size;
      if (c.status && isDownCode(code)) {
        down = true;
        error = `Erreur HTTP ${code}`;
      }
    }
    if (down && !maint) {
      state.fails = (state.fails || 0) + 1;
      state.failSince ||= now; // la panne est datée du premier échec, pas de sa confirmation
    } else {
      // Un échec pendant une maintenance n'est pas une panne : il ne compte pas, même rétroactivement à la reprise.
      state.fails = 0;
      state.failSince = null;
    }
    const confirmed = down && !maint && state.fails >= cfg.failThreshold;
    if (confirmed && !state.outageId) state.outageId = await openOutage(w.id, state.failSince, error, code);
    if (!down && state.outageId) {
      closedOutage = await closeOutage(state.outageId, now);
      state.outageId = null;
    }

    if (pageErr) {
      if (confirmed) {
        evaluated.add('net');
        inc('down', 'critical', pageErr.tls ? 'Problème de certificat TLS' : 'Site inaccessible', pageErr.message);
      }
    } else {
      evaluated.add('content');
      if (!down || confirmed) evaluated.add('net');
      if (confirmed) inc('http', 'critical', `Erreur HTTP ${code}`, `${w.url} répond ${code}.`);
      else if (!down && c.status && code >= 400) inc('http', 'warning', `Erreur HTTP ${code}`, `${w.url} répond ${code} (accès restreint ou protégé).`);
    }
  }

  // ── Contenu, redirections, scripts… ──
  if (page) {
    const p = page;
    const finalU = new URL(p.finalUrl);
    if (c.redirect) {
      if (url.protocol === 'https:' && finalU.protocol === 'http:') inc('downgrade', 'warning', 'Le site est retombé en HTTP (non chiffré)', p.finalUrl);
      if (baseline && state.finalUrl) {
        const was = new URL(state.finalUrl);
        const allowed = cfg.allowedHosts.some((h) => h === finalU.hostname || h === registrable(finalU.hostname));
        if (registrable(finalU.hostname) !== registrable(was.hostname) && !allowed) {
          add('redirect_domain', 'critical', 'Le site redirige vers un autre domaine', `${state.finalUrl} → ${p.finalUrl}`);
        } else if (finalU.origin + finalU.pathname !== was.origin + was.pathname) {
          add('redirect_changed', 'warning', 'La destination finale de la redirection a changé', `${state.finalUrl} → ${p.finalUrl}`);
        }
      }
    }
    state.finalUrl = p.finalUrl;

    if (c.server && baseline && (state.server ?? p.server) !== p.server) {
      add('server_changed', 'info', 'Le logiciel serveur a changé', `« ${state.server || '—'} » → « ${p.server || '—'} »`);
    }
    state.server = p.server;

    const a = analyze(p, cfg);
    hash = a.hash;
    const f = a.features;
    const fullText = a.fullLines.join('\n').toLowerCase();

    if (a.selectorMissing) inc('selector', 'warning', 'Le sélecteur CSS ne trouve plus aucun élément', `« ${cfg.selector} » — la structure de la page a peut-être changé.`);

    // Mots-clés de piratage / spam (états)
    if (c.keywords && fullText) {
      const words = [...new Set([...settings.builtinKeywords, ...cfg.forbidden].map((s) => s.toLowerCase().trim()).filter(Boolean))];
      const hits = words.filter((k) => wordIndex(fullText, k) >= 0).slice(0, 12);
      if (hits.length) {
        const quote = (arr) => arr.map((k) => `« ${k} »`).join(', ');
        inc('forbidden', 'critical',
          hits.length === 1 ? `Texte suspect détecté : « ${hits[0]} »` : `${hits.length} textes suspects détectés : ${quote(hits.slice(0, 4))}${hits.length > 4 ? '…' : ''}`,
          context(fullText, hits[0]));
        // Incident déjà actif : on ne ré-alerte que pour un mot nouvellement apparu.
        const fresh = hits.filter((k) => !(state.forbiddenHits || []).includes(k));
        if (state.incidents?.forbidden && fresh.length) add('forbidden', 'critical', `Nouveau texte suspect : ${quote(fresh)}`, context(fullText, fresh[0]));
      }
      state.forbiddenHits = hits;
    }
    for (const r of cfg.required) {
      if (fullText && !fullText.includes(r.toLowerCase())) inc(`required:${r}`, 'critical', `Texte attendu absent : « ${r} »`, "Le contenu normal de la page n'est plus présent.");
    }

    // Signaux techniques (évènements)
    if (f) {
      if (f.suspects.length) {
        const fresh = f.suspects.filter((s) => !(state.suspects || []).includes(s));
        if (fresh.length && baseline) add('script_suspect', 'critical', 'Script JavaScript suspect (obfusqué / redirection)', fresh[0]);
      }
      if (c.title && baseline && state.title !== undefined && state.title !== f.title) add('title_changed', 'warning', 'Le titre de la page a changé', `« ${state.title} » → « ${f.title} »`);
      if (c.scripts && baseline && state.scripts) {
        const fresh = f.scripts.filter((s) => !state.scripts.includes(s));
        if (fresh.length) {
          const ext = fresh.filter((s) => registrable(new URL(s).hostname) !== domain);
          add('script_added', ext.length ? 'critical' : 'warning', ext.length ? 'Nouveau script externe chargé par la page' : 'Nouveau script ajouté à la page', fresh.slice(0, 5).join('\n'));
        }
      }
      if (c.links && baseline && state.linkHosts) {
        const nf = f.iframeHosts.filter((h) => !(state.iframeHosts || []).includes(h));
        const nfo = f.formHosts.filter((h) => !(state.formHosts || []).includes(h));
        const nl = f.linkHosts.filter((h) => !state.linkHosts.includes(h));
        if (nf.length) add('iframe_added', 'critical', 'Iframe externe injectée dans la page', nf.join(', '));
        if (nfo.length) add('form_hijacked', 'critical', 'Un formulaire envoie désormais ses données vers un domaine externe', nfo.join(', '));
        if (nl.length) add('links_added', nl.length >= 3 ? 'warning' : 'info', `${nl.length} nouveau(x) domaine(s) externe(s) lié(s)`, nl.slice(0, 8).join(', '));
        if (f.metaRefresh && f.metaRefresh !== state.metaRefresh) add('meta_refresh', 'critical', 'Redirection <meta refresh> détectée', f.metaRefresh);
      }
      Object.assign(state, { title: f.title, scripts: f.scripts, linkHosts: f.linkHosts, iframeHosts: f.iframeHosts, formHosts: f.formHosts, metaRefresh: f.metaRefresh, suspects: f.suspects });
    }

    // Contenu : snapshot + diff
    if (code < 400) {
      const prev = await latestSnapshot(w.id);
      if (!prev || prev.hash !== a.hash) {
        const prevLines = prev ? snapshotLines(prev) : [];
        const d = prev ? diffLines(prevLines, a.lines) : null;
        const pct = d ? ((d.added + d.removed) / Math.max(1, prevLines.length + a.lines.length)) * 100 : 0;
        snapshotId = await insertSnapshot(w.id, {
          hash: a.hash, lines: a.lines, title: a.title, size,
          meta: d ? { added: d.added, removed: d.removed, similarity: +d.similarity.toFixed(3), pct: +pct.toFixed(2) } : { baseline: true },
        });
        if (d && c.content && baseline && !a.binary && pct >= cfg.minChangePct) {
          const replaced = prevLines.length >= 5 && d.similarity < 0.25;
          add('content_changed', replaced ? 'critical' : 'warning', replaced ? 'Le contenu de la page a été entièrement remplacé' : 'Le contenu de la page a changé',
            `${d.added} ligne(s) ajoutée(s), ${d.removed} supprimée(s) · similarité ${Math.round(d.similarity * 100)} %`,
            { snapshotId, prevSnapshotId: prev.id, diffPreview: preview(d.ops) });
          const was = prevLines.join('\n').length;
          const now2 = a.lines.join('\n').length;
          if (c.sizeDrop && was > 800 && now2 < was * 0.2) add('size_collapse', 'critical', 'La page est presque vide', `${was} → ${now2} caractères de texte`);
        }
      } else snapshotId = prev.id;
    }
  }

  // ── Pages supplémentaires : disponibilité, mots-clés de piratage et signaux techniques (scripts, iframes, formulaires) ──
  // Pas de comparaison du texte : un panier ou un espace client change à chaque visite. Ces pages ne comptent pas dans la disponibilité du site.
  const wanted = new Set(extra.map((x) => x.href));
  for (const k of Object.keys(state.incidents || {})) {
    if (catOf(k) === 'pages' && !wanted.has(k.slice(k.indexOf(':') + 1))) delete state.incidents[k]; // page retirée de la liste : pas de message « rétabli »
  }
  if (extraJob) {
    evaluated.add('pages');
    const results = await extraJob;
    const prevPages = state.pages || {};
    const nextPages = {};
    const words = [...new Set([...settings.builtinKeywords, ...cfg.forbidden].map((s) => s.toLowerCase().trim()).filter(Boolean))];
    const pageCfg = { ...cfg, selector: '', excludeSelector: '' };
    extra.forEach(({ p, href }, idx) => {
      const r = results[idx];
      const name = pageName(href, p);
      const ps = { ...(prevPages[href] || {}) };
      const pbaseline = !!ps.baseline;
      const tag = (title) => `${title} — page « ${name} »`;
      const padd = (type, sev, title, detail = '') => add(`page_${type}`, sev, tag(title), `${href}${detail ? `\n${detail}` : ''}`);
      let problem = null;
      if (r.status === 'rejected') problem = describeError(r.reason).message;
      else if (isDownCode(r.value.status)) problem = `Erreur HTTP ${r.value.status}`;
      if (problem) {
        // Comme pour le site : plusieurs échecs de suite avant d'alerter ; une panne passagère ne déclenche rien, et rien n'est « rétabli » en attendant.
        ps.fails = maint ? 0 : (ps.fails || 0) + 1;
        ps.error = problem;
        const confirmed = ps.fails >= cfg.failThreshold;
        if (confirmed) inc(`page_down:${href}`, 'warning', tag('Page inaccessible'), `${href}\n${problem}`);
        // La page ne répond pas : ce qu'on savait d'elle (texte suspect) reste vrai tant qu'on ne peut pas le revérifier.
        for (const [k, i] of Object.entries(state.incidents || {})) {
          if (!k.endsWith(`:${href}`) || (confirmed && k.startsWith('page_down:'))) continue;
          incidents[k] = { severity: i.severity, title: i.title, detail: i.detail, ...(i.count != null ? { count: i.count } : {}) };
        }
        ps.checkedAt = now;
        nextPages[href] = ps;
        return;
      }
      const page = r.value;
      ps.fails = 0;
      ps.error = null;
      ps.code = page.status;
      ps.ms = page.ms;
      ps.checkedAt = now;
      ps.finalUrl = page.finalUrl;
      const a = analyze(page, pageCfg);
      const f = a.features;
      if (c.keywords && a.fullLines.length) {
        const text = a.fullLines.join('\n').toLowerCase();
        const hits = words.filter((k) => wordIndex(text, k) >= 0).slice(0, 12);
        if (hits.length) {
          inc(`page_forbidden:${href}`, 'critical', tag(hits.length === 1 ? `Texte suspect détecté : « ${hits[0]} »` : `${hits.length} textes suspects détectés`), `${href}\n${context(text, hits[0])}`, hits.length);
        }
      }
      if (f) {
        if (pbaseline) {
          const fresh = f.suspects.filter((s) => !(ps.suspects || []).includes(s));
          if (fresh.length) padd('script_suspect', 'critical', 'Script JavaScript suspect (obfusqué / redirection)', fresh[0]);
          if (c.title && ps.title !== undefined && ps.title !== f.title) padd('title_changed', 'warning', 'Le titre de la page a changé', `« ${ps.title} » → « ${f.title} »`);
          if (c.scripts && ps.scripts) {
            const added = f.scripts.filter((s) => !ps.scripts.includes(s));
            if (added.length) {
              const ext = added.filter((s) => registrable(new URL(s).hostname) !== domain);
              padd('script_added', ext.length ? 'critical' : 'warning', ext.length ? 'Nouveau script externe chargé par la page' : 'Nouveau script ajouté à la page', added.slice(0, 5).join('\n'));
            }
          }
          if (c.links && ps.linkHosts) {
            const nf = f.iframeHosts.filter((h) => !(ps.iframeHosts || []).includes(h));
            const nfo = f.formHosts.filter((h) => !(ps.formHosts || []).includes(h));
            if (nf.length) padd('iframe_added', 'critical', 'Iframe externe injectée dans la page', nf.join(', '));
            if (nfo.length) padd('form_hijacked', 'critical', 'Un formulaire envoie désormais ses données vers un domaine externe', nfo.join(', '));
            if (f.metaRefresh && f.metaRefresh !== ps.metaRefresh) padd('meta_refresh', 'critical', 'Redirection <meta refresh> détectée', f.metaRefresh);
          }
        }
        Object.assign(ps, { baseline: true, title: f.title, scripts: f.scripts, linkHosts: f.linkHosts, iframeHosts: f.iframeHosts, formHosts: f.formHosts, metaRefresh: f.metaRefresh, suspects: f.suspects });
      } else ps.baseline = true;
      nextPages[href] = ps;
    });
    state.pages = nextPages;
  } else if (state.pages) delete state.pages;

  // ── DNS : détournement de zone, de site ou de messagerie ──
  if (dnsR.status === 'fulfilled') {
    const d = dnsR.value;
    if (d.a.length + d.aaaa.length + d.cname.length + d.ns.length > 0) {
      evaluated.add('dns');

      // Cohérence : tous les résolveurs doivent annoncer les mêmes serveurs de noms.
      const sets = new Map();
      for (const [name, ns] of Object.entries({ 'Résolveur local': d.ns, ...d.resolvers })) {
        if (ns.length) sets.set(JSON.stringify(ns), [...(sets.get(JSON.stringify(ns)) || []), name]);
      }
      if (sets.size > 1) {
        inc('dns_inconsistent', 'warning', 'Les résolveurs DNS ne renvoient pas les mêmes serveurs de noms',
          [...sets].map(([k, names]) => `${names.join(', ')} : ${JSON.parse(k).join(', ')}`).join('\n') + '\n\nPropagation en cours après un changement légitime, ou détournement de la zone.');
      }

      const o = state.dns;
      if (baseline && o) {
        if (d.ns.length && o.ns?.length && !same(d.ns, o.ns)) add('dns_ns', 'critical', 'Les serveurs de noms (NS) du domaine ont changé', `${o.ns.join(', ')}\n→ ${d.ns.join(', ')}\n\nPossible transfert ou détournement de domaine.`);
        const ips = [...d.a, ...d.aaaa];
        const seen = new Set(state.seenPrefixes || []);
        if (ips.length && seen.size && ips.every((ip) => !seen.has(ipPrefix(ip)))) {
          add('dns_ip', 'warning', "L'adresse IP du site a changé (nouvel hébergeur ?)", `${[...(o.a || []), ...(o.aaaa || [])].join(', ') || '—'}\n→ ${ips.join(', ')}`);
        }
        if (d.cname.length && o.cname?.length && !same(d.cname, o.cname)) add('dns_cname', 'warning', 'Le CNAME du site a changé', `${o.cname.join(', ')} → ${d.cname.join(', ')}`);
        if (d.mx.length && o.mx?.length && !same(d.mx, o.mx)) add('dns_mx', 'warning', 'Les serveurs de messagerie (MX) ont changé', `${o.mx.join(', ')}\n→ ${d.mx.join(', ')}\n\nUn détournement de domaine sert souvent à intercepter les e-mails.`);
        if (d.spf && o.spf && d.spf !== o.spf) add('dns_spf', 'warning', "L'enregistrement SPF a changé", `${o.spf}\n→ ${d.spf}`);
        if (d.dmarc && o.dmarc && d.dmarc !== o.dmarc) add('dns_dmarc', 'warning', "L'enregistrement DMARC a changé", `${o.dmarc}\n→ ${d.dmarc}`);
        if (d.caa.length && o.caa?.length && !same(d.caa, o.caa)) add('dns_caa', 'warning', 'Les autorités de certification autorisées (CAA) ont changé', `${o.caa.join(' · ')}\n→ ${d.caa.join(' · ')}`);
      }
      const seen = new Set(state.seenPrefixes || []);
      [...d.a, ...d.aaaa].forEach((ip) => seen.add(ipPrefix(ip)));
      state.seenPrefixes = [...seen].slice(-200);
      // Une valeur vide peut être un échec de requête passager : on garde la dernière valeur connue.
      const keep = (k, v) => (Array.isArray(v) ? (v.length ? v : state.dns?.[k] || []) : v || state.dns?.[k] || '');
      state.dns = {
        a: d.a, aaaa: d.aaaa, cname: d.cname, zone: d.zone,
        ns: keep('ns', d.ns), mx: keep('mx', d.mx), caa: keep('caa', d.caa), spf: keep('spf', d.spf), dmarc: keep('dmarc', d.dmarc),
      };
      state.resolvers = d.resolvers;
    }
  }

  // ── TLS ──
  if (tlsR.status === 'fulfilled') {
    const t = tlsR.value;
    evaluated.add('tls');
    if (!t.authorized) inc('tls_invalid', 'critical', 'Certificat TLS invalide', t.authError);
    const days = Math.floor((t.expires - now) / DAY);
    if (days < 14) inc('tls_expiring', days < 3 ? 'critical' : 'warning', days < 0 ? 'Certificat TLS expiré' : `Le certificat TLS expire dans ${days} jour(s)`, `Valide jusqu'au ${dateFr(t.expires)}`);
    if (baseline && state.tls && state.tls.fp !== t.fp) {
      const o = state.tls;
      if (o.issuer !== t.issuer || o.subject !== t.subject) add('tls_changed', 'critical', 'Le certificat TLS a été émis par un autre émetteur', `${o.issuer || '?'} (${o.subject}) → ${t.issuer || '?'} (${t.subject})`);
      else add('tls_renewed', 'info', 'Certificat TLS renouvelé', `Nouvelle échéance : ${dateFr(t.expires)}`);
    }
    state.tls = { fp: t.fp, issuer: t.issuer, subject: t.subject, expires: t.expires, authorized: t.authorized, protocol: t.protocol };
  }

  // ── Registre du domaine (RDAP) : transfert, registrar, serveurs de noms, verrou, DNSSEC ──
  if (rdapR.status === 'fulfilled') {
    const r = rdapR.value;
    if (r.unsupported) state.rdap = { checkedAt: now, unsupported: true };
    else {
      evaluated.add('rdap');
      const o = state.rdap && !state.rdap.unsupported ? state.rdap : null;
      if (baseline && o) {
        if (o.registrar && r.registrar && o.registrar !== r.registrar) add('rdap_registrar', 'critical', 'Le registrar du domaine a changé (transfert)', `${o.registrar} → ${r.registrar}`);
        else if (r.transferred && r.transferred > (o.transferred || 0)) add('rdap_transfer', 'critical', 'Un transfert du nom de domaine a été enregistré', `Le ${dateFr(r.transferred)}`);
        if (o.locked && !r.locked) add('rdap_unlocked', 'warning', 'Le verrou anti-transfert du domaine a été retiré', `Statuts : ${r.status.join(', ') || '—'}`);
        if (o.nameservers?.length && r.nameservers.length && !same(o.nameservers, r.nameservers)) {
          add('rdap_ns', 'critical', 'Les serveurs de noms déclarés au registre ont changé', `${o.nameservers.join(', ')}\n→ ${r.nameservers.join(', ')}\n\nC'est la délégation officielle du domaine : elle change immédiatement, sans cache DNS.`);
        }
        if (o.dnssec === true && r.dnssec === false) add('rdap_dnssec', 'critical', 'DNSSEC a été désactivé sur le domaine', 'La signature DNSSEC est retirée lors de nombreux détournements de zone.');
        else if (o.dnssec === false && r.dnssec === true) add('rdap_dnssec_on', 'info', 'DNSSEC a été activé sur le domaine');
        if (r.changed && r.changed > (o.changed || 0)) add('rdap_changed', 'info', 'Le registre signale une modification du domaine', `Dernière modification : ${dateFr(r.changed)}`);
      }
      if (r.expires) {
        const days = Math.floor((r.expires - now) / DAY);
        if (days < 30) inc('rdap_expiring', days < 7 ? 'critical' : 'warning', days < 0 ? 'Le nom de domaine a expiré' : `Le nom de domaine expire dans ${days} jour(s)`, `${domain} · échéance le ${dateFr(r.expires)}`);
      }
      const risky = r.status.filter((s) => RISKY_STATUS.test(s));
      if (risky.length) inc('rdap_status', 'critical', `Statut sensible du domaine : ${risky.join(', ')}`, 'Transfert en cours, domaine suspendu ou en cours de suppression.');
      state.rdap = {
        checkedAt: now, registrar: r.registrar, registered: r.registered, expires: r.expires, transferred: r.transferred, changed: r.changed,
        locked: r.locked, status: r.status, nameservers: r.nameservers, dnssec: r.dnssec,
      };
    }
  } else if (rdapDue) {
    state.rdap = { ...(state.rdap || {}), checkedAt: now - RDAP_EVERY + 10 * 60e3 }; // réessai dans 10 min
  }

  // ── CMS : mises à jour, support de PHP, intégrité des fichiers, comptes administrateurs (relevé séparé du plugin, 12 h par défaut) ──
  if (!domainOnly && cfg.cms.type) {
    const updates = cfg.cms.alerts !== false;
    const security = cfg.cms.security !== false;
    // Un groupe d'alertes désactivé : ses incidents disparaissent sans message « rétabli ».
    for (const k of Object.keys(state.incidents || {})) {
      if (catOf(k) === 'cms' && !(cmsIncidentGroup(k) === 'security' ? security : updates)) delete state.incidents[k];
    }
    if ((updates || security) && state.cms?.core && state.cms.checkedAt) {
      evaluated.add('cms');
      for (const i of cmsIncidents(state.cms, { afterDays: settings.cmsAfterDays, now, updates, security })) inc(i.key, i.severity, i.title, i.detail, i.count);
    }
  } else {
    // CMS retiré : ses incidents disparaissent sans message « rétabli ».
    for (const k of Object.keys(state.incidents || {})) if (catOf(k) === 'cms') delete state.incidents[k];
  }

  // ── Transitions d'incidents ──
  const prevInc = state.incidents || {};
  for (const [key, i] of Object.entries(incidents)) {
    const prev = prevInc[key];
    // L'échéance du domaine (sous 7 jours), un CMS en retard ou PHP en fin de support deviennent critiques : on ré-alerte,
    // même si le premier rappel a été marqué comme lu.
    // Un incident qui grossit (plus de fichiers suspects, de comptes, de mots) ré-alerte aussi : le premier message ne les mentionnait pas.
    const escalated = prev && (
      ((key === 'rdap_expiring' || key === 'php_eol' || key.startsWith('cms_')) && (SEV[i.severity] || 0) > (SEV[prev.severity] || 0))
      || (i.count != null && i.count > (prev.count ?? 0)));
    // Incident apparu pendant une maintenance : son alerte a été retenue, on prévient dès la reprise s'il est toujours là.
    const deferred = prev?.muted && !maint;
    if (!prev || escalated || deferred) add(key.split(':')[0], i.severity, i.title, i.detail);
  }
  for (const [key, i] of Object.entries(prevInc)) {
    if (incidents[key] || !evaluated.has(catOf(key))) continue;
    if (i.muted) continue; // apparu et disparu pendant la maintenance : personne n'en a été prévenu, pas de « rétabli »
    if (closedOutage && ['down', 'http'].includes(key)) continue; // remplacé par le message de fin de panne, avec sa durée
    add('recovery', 'recovery', `Rétabli : ${i.title}`, '', { was: i.severity });
  }
  if (closedOutage) {
    add('recovery', 'recovery', 'Le site est de nouveau accessible', `Indisponible pendant ${fmtDuration(closedOutage.end - closedOutage.start)}.`, { was: 'critical' });
  }
  state.incidents = {};
  for (const [key, i] of Object.entries(incidents)) {
    const prev = prevInc[key];
    state.incidents[key] = { ...i, since: prev?.since || now, ...(maint && (!prev || prev.muted) ? { muted: true } : {}) };
  }
  for (const [key, i] of Object.entries(prevInc)) if (!incidents[key] && !evaluated.has(catOf(key))) state.incidents[key] = i;

  // Un acquittement ne vaut que pour l'incident en cours : s'il disparaît puis revient, il redevient visible.
  if (state.incidentAck) {
    for (const k of Object.keys(state.incidentAck)) if (!state.incidents[k]) delete state.incidentAck[k];
  }

  if (page || domainOnly) state.baseline = true;

  // ── Maintenance : alertes retenues pendant la fenêtre, puis un seul récapitulatif à la reprise ──
  if (maint) {
    for (const a of alerts) a.maintenance = true;
  } else {
    const held = await pendingMaintenanceAlerts(w.id);
    if (held.length) {
      const notable = held.filter((a) => a.severity === 'critical' || a.severity === 'warning');
      if (notable.length) {
        const worst = notable.some((a) => a.severity === 'critical') ? 'critical' : 'warning';
        add('maintenance_summary', worst,
          `Fin de la maintenance : ${notable.length} alerte${notable.length > 1 ? 's' : ''} retenue${notable.length > 1 ? 's' : ''} pendant la fenêtre`,
          [...new Set(notable.map((a) => `• ${a.title}`))].slice(0, 10).join('\n'));
      }
      await markMaintenanceSummarized(w.id);
    }
  }

  // ── Persistance + notification ──
  const up = domainOnly ? true : !down;
  await insertCheck({ watchId: w.id, ok: up, code, ms, size, hash, snapshotId, error, alerts: alerts.length });
  if (!domainOnly && !(maint && down)) await upsertDaily(w.id, now, up, ms);
  for (const a of alerts) a.id = await insertAlert({ watchId: w.id, ...a });
  // À la fin d'une maintenance, un contrôle suit de près : les alertes retenues sont reprises sans attendre l'intervalle normal.
  const nextRun = maint && maint.end + 30e3 < now + w.interval * 60e3 ? maint.end + 30e3 : now + w.interval * 60e3;
  await saveRun(w.id, { state, nextRun, code, ms, error });
  await prune(w.id);

  const { photo } = await notify(w, alerts.filter((a) => !a.maintenance), settings);
  bus.emit('event', { type: 'check', watchId: w.id, alerts: alerts.length });
  return { code, ms, error, alerts, photo };
}

/** Alertes dont la gravité se voit sur la page : une capture d'écran de l'état actuel les accompagne. */
const VISUAL = new Set(['content_changed', 'size_collapse', 'forbidden', 'required', 'script_added', 'script_suspect', 'iframe_added', 'form_hijacked', 'meta_refresh', 'redirect_domain']);

/** Retourne { photo } : la promesse de l'envoi de la capture (non attendue par le contrôle, qui ne doit pas ralentir). */
async function notify(w, alerts, settings) {
  if (!alerts.length || !w.config.notify) return {};
  // Quels canaux reçoivent ces alertes ? Par défaut, Telegram (réglages) ; la version hébergée en ajoute (src/extensions.js).
  const channels = await getExtensions().notifier.resolveChannels(w, alerts, settings);
  const reached = []; // { channel, eligible } : canaux qui ont bien reçu quelque chose
  const outcome = new Map(); // id d'alerte → null (envoyée) ou message d'erreur
  for (const channel of channels) {
    const eligible = eligibleFor(channel, alerts);
    if (!eligible.length) continue;
    try {
      await channel.send(w, eligible, settings);
      reached.push({ channel, eligible });
      for (const a of eligible) outcome.set(a.id, null); // un seul canal qui aboutit suffit : l'alerte est « envoyée »
    } catch (e) {
      console.error(`[${channel.type}] ${w.name}: ${e.message}`);
      for (const a of eligible) if (!outcome.has(a.id)) outcome.set(a.id, e.message);
    }
  }
  const sentIds = [...outcome].filter(([, err]) => err === null).map(([id]) => id);
  if (sentIds.length) await markNotified(sentIds);
  const failed = new Map(); // message d'erreur → alertes
  for (const [id, err] of outcome) if (err !== null) failed.set(err, [...(failed.get(err) ?? []), id]);
  for (const [err, ids] of failed) await markNotified(ids, err);

  // Une photo vaut mieux qu'un long message : le pirate a-t-il remplacé la page ? On le voit d'un coup d'œil, depuis le téléphone.
  const photoTargets = reached.filter(({ channel, eligible }) => channel.wantsPhoto && channel.sendPhoto
    && eligible.some((a) => a.severity === 'critical' && VISUAL.has(a.type)));
  if (!photoTargets.length || w.config.mode === 'domain' || !w.config.screenshot.enabled || !engine.available()) return {};
  const photo = captureWatch(w.id, { kind: 'alert' })
    .then(async (r) => {
      if (!r.image) return null;
      // Une seule capture, envoyée à chaque canal concerné ; l'échec de l'un ne prive pas les autres.
      for (const { channel } of photoTargets) {
        await channel.sendPhoto(r.image, `📸 ${w.name} — la page au moment de l'alerte`).catch((e) => console.error(`[${channel.type}] capture ${w.name}: ${e.message}`));
      }
    })
    .catch((e) => console.error(`[capture] ${w.name}: ${e.message}`));
  return { photo };
}
