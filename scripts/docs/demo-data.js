// Jeu de données FICTIF pour la documentation et l'essai à blanc (npm run demo).
//
// Tout est inventé : noms, domaines (TLD réservé « .example », RFC 2606), adresses IP (plages de documentation
// 203.0.113.0/24 et 2001:db8::/32), registrars, alertes. Les données sont écrites directement en base, avec des
// horodatages relatifs à « maintenant » : l'historique reste crédible quel que soit le jour où le script tourne.
//
// Trois histoires pour illustrer l'application : un site DÉFIGURÉ (Fromagerie Dupont), un site EN PANNE (Maison
// Lumière) et un certificat TLS qui expire bientôt (Garage Leroy) ; le domaine seul expire dans 3 semaines.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITES, linesOf, DEFACED_LINES } from './fake-sites.js';
import { cmsIncidents, phpSupport, PHP_WARN_DAYS } from '../../src/cms-alerts.js';

export const DEMO_USER = 'demo';
export const DEMO_PASSWORD = 'demo-password';

const MIN = 60e3, H = 3600e3, D = 86400e3;

/** Générateur pseudo-aléatoire reproductible (mulberry32) : mêmes courbes à chaque exécution. */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const GROUPS = [['Clients', '#10b981'], ['Boutiques en ligne', '#f59e0b'], ['Interne', '#0ea5e9']];

const DEFS = [
  { slug: 'dupont', group: 0, ms: 210, server: 'nginx', registrar: 'Gandi SAS', dnssec: true, story: 'defaced' },
  { slug: 'martin', group: 0, ms: 165, server: 'Apache', registrar: 'OVH SAS', dnssec: true, story: 'mx', cms: 'wordpress' },
  { slug: 'leroy', group: 0, ms: 320, server: 'nginx', registrar: 'Gandi SAS', dnssec: false, story: 'tls' },
  { slug: 'nova', group: 1, ms: 140, server: 'cloudflare', registrar: 'Cloudflare, Inc.', dnssec: true, story: 'links', cms: 'prestashop' },
  { slug: 'lumiere', group: 1, ms: 260, server: 'nginx', registrar: 'OVH SAS', dnssec: false, story: 'down' },
  { slug: 'intranet', group: 2, ms: 55, server: 'nginx', registrar: 'Gandi SAS', dnssec: true, story: 'server' },
  { slug: 'wiki', group: 2, ms: 80, server: 'nginx', registrar: 'Gandi SAS', dnssec: true },
];

// Pannes passées (début = il y a X, durée) ; « open » = en cours.
const OUTAGES = {
  dupont: [{ ago: 20 * D, dur: 6 * MIN, reason: 'Délai dépassé' }],
  martin: [{ ago: 40 * D, dur: 14 * MIN, reason: 'Délai dépassé' }],
  leroy: [{ ago: 9 * D, dur: 12 * MIN, reason: 'Erreur HTTP 503', code: 503 }, { ago: 46 * D, dur: 7 * MIN, reason: 'Erreur HTTP 502', code: 502 }],
  nova: [{ ago: 31 * D, dur: 4 * MIN, reason: 'Délai dépassé' }, { ago: 57 * D, dur: 38 * MIN, reason: 'Erreur HTTP 503', code: 503 }],
  lumiere: [{ ago: 17 * D, dur: 125 * MIN, reason: 'Erreur HTTP 503', code: 503 }, { ago: 27 * MIN, open: true, reason: 'Connexion refusée par le serveur' }],
  intranet: [],
  wiki: [{ ago: 3 * D, dur: 9 * MIN, reason: 'Délai dépassé' }],
};

// Relevés « plugin » fictifs (onglet Mises à jour). Noms et versions inventés : aucune vraie boutique ni installation.
const DEMO_CMS_TOKEN = 'ZGVtby1qZXRvbi1mYXV4LXBvdXItbGEtZG9jdW1lbnRhdGlvbg';
const item = (name, slug, current, available = null, o = {}) => ({ name, slug, current, available, active: true, known: true, ...o });
const CMS_REPORTS = {
  martin: {
    php: '8.3.14', cms: 'wordpress', cmsVersion: '6.7.1',
    core: { current: '6.7.1', available: '6.8.3', known: true, age: 12 },
    extensions: [
      item('Yoast SEO', 'wordpress-seo', '24.2', '25.4', { age: 9 }),
      item('Contact Form 7', 'contact-form-7', '5.9.8', '6.1.1', { age: 3 }),
      item('Complianz', 'complianz-gdpr', '7.4.0'),
      item('Akismet Anti-spam', 'akismet', '5.3.5'),
      item('Redirection', 'redirection', '5.5.0'),
      item('Hello Dolly', 'hello-dolly', '1.7.2', null, { active: false }),
    ],
    themes: [
      item('Cabinet Martin (thème enfant)', 'cabinet-martin-child', '2.4.0'),
      item('Twenty Twenty-Five', 'twentytwentyfive', '1.0', '1.3', { active: false, age: 8 }),
    ],
  },
  nova: {
    php: '8.2.27', cms: 'prestashop', cmsVersion: '8.1.7',
    core: { current: '8.1.7', available: '8.2.1', known: true, age: 4 },
    extensions: [
      item('Paiement par carte', 'paymentcard', '3.5.2', '3.6.0', { age: 2 }),
      item('Panier', 'ps_shoppingcart', '2.0.7', '2.0.9', { age: 5 }),
      item('Newsletter', 'ps_emailsubscription', '2.9.0'),
      item('Paiement par chèque', 'ps_checkpayment', '2.0.2'),
      item('Export du catalogue (sur mesure)', 'nova_feed', '1.4', null, { known: false }),
      item('Transporteur local', 'novashipping', '0.9.3', null, { known: false, active: false }),
    ],
    themes: [
      item('Classic', 'classic', '2.0.3', '2.1.0', { active: false, age: 6 }),
      item('Nova (thème sur mesure)', 'nova', '1.2.0', null, { known: false }),
    ],
  },
};

/** Les relevés ci-dessus donnent l'âge de chaque mise à jour en jours ; le relevé enregistré en base porte l'horodatage `since`. */
const withSince = (report, now) => {
  const conv = ({ age, ...it }) => (age != null ? { ...it, since: now - age * D } : it);
  return { ...report, core: conv(report.core), extensions: report.extensions.map(conv), themes: report.themes.map(conv) };
};

const hex = (n, seed) => { const r = rng(seed); return Array.from({ length: n }, () => Math.floor(r() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':'); };
const fmtDate = (t) => new Date(t).toLocaleDateString('fr-FR');

export async function seedDemo({ dataDir, fakeSitesBase }) {
  mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  const dbm = await import('../../src/db.js');
  const { capture, chromePath } = await import('../../src/screenshot.js');
  const { diffLines } = await import('../../src/diff.js');
  const { sha1, fmtDuration } = await import('../../src/util.js');
  const { db } = dbm;
  // Ancienne écriture `stmt(sql).run(...)` : l'adaptateur de base n'a que run / get / all (sql, paramètres).
  const stmt = (sql) => ({ run: (...params) => db.run(sql, params) });
  const now = Date.now();
  const REPORT = Object.fromEntries(Object.entries(CMS_REPORTS).map(([slug, r]) => [slug, withSince(r, now)]));
  // Moment où chaque incident CMS a franchi son seuil (le vrai code recalcule titre et détail à cet instant).
  const phpNova = phpSupport(REPORT.nova.php, now);
  const AGO = { martin: { cms_core: 5 * D, cms_updates: 2 * D }, nova: { php_eol: phpNova.status === 'ending' ? now - (phpNova.endsAt - PHP_WARN_DAYS * D) : phpNova.endsAt ? now - phpNova.endsAt : 2 * D } };
  const incidentAt = (slug, key) => cmsIncidents(REPORT[slug], { afterDays: 7, now: now - AGO[slug][key] }).find((i) => i.key === key) ?? cmsIncidents(REPORT[slug], { afterDays: 7, now }).find((i) => i.key === key);

  // ── Captures d'écran : les faux sites sont réellement rendus par le moteur de capture de l'application ──
  const shot = async (path) => capture(`${fakeSitesBase}${path}`, { width: 1280, height: 800, settleMs: 150, interact: false, hideBanners: false, timeoutMs: 20000 });
  // Sans Chrome sur la machine, on n'enregistre simplement aucune capture : le reste de la démonstration fonctionne.
  const canShoot = !!chromePath();
  const images = {};
  if (canShoot) {
    for (const d of DEFS) images[d.slug] = await shot(`/${d.slug}`);
    images.dupontDefaced = await shot('/dupont?defaced=1');
  }

  // ── Réglages : Telegram « configuré » avec un faux jeton (jamais utilisé : aucun envoi en mode démo) ──
  await dbm.saveSettings({
    telegram: { token: `123456789:${'DEMO'.padEnd(35, '0')}`, chatId: '987654321', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true, sendScreenshot: true },
    baseUrl: 'https://suricateweb.exemple-societe.example',
  });

  // ── Groupes et sites ──
  const gid = [];
  for (const [name, color] of GROUPS) gid.push((await dbm.createGroup({ name, color })).id); // dans l'ordre : l'ordre des groupes est celui de création
  const watches = [];
  const addWatch = async (def, extra) => {
    const w = await dbm.createWatch({ name: def.name, url: def.url, interval: 15, tags: def.tags ?? [], groupId: def.group == null ? null : gid[def.group], config: def.config ?? {} });
    watches.push({ ...def, id: w.id, ...extra });
    return w.id;
  };
  for (const [i, d] of DEFS.entries()) {
    await addWatch({ ...d, name: SITES[d.slug].name, url: `https://${SITES[d.slug].domain}/`, tags: d.slug === 'dupont' ? ['client', 'wordpress'] : [],
      config: d.cms ? { cms: { type: d.cms, token: DEMO_CMS_TOKEN, path: '', intervalMin: 720 } } : {} }, { i });
  }
  await addWatch({ slug: 'domain', name: 'exemple-societe.example', url: 'https://exemple-societe.example/', group: null, config: { mode: 'domain' }, story: 'domain', registrar: 'Gandi SAS', dnssec: true, ms: 0 }, { i: 7 });

  await db.exec('BEGIN');
  const outageIds = {};
  const alerts = [];
  const alert = (w, ago, sev, type, title, detail = '', o = {}) => alerts.push({ w, ts: now - ago, sev, type, title, detail, ...o });

  for (const w of watches) {
    const site = SITES[w.slug];
    const domainName = site ? site.domain : 'exemple-societe.example';
    const root = domainName.replace(/^(www|intranet|wiki)\./, '');
    const every = 15 * MIN;
    const r = rng(1000 + w.i);
    const outs = (OUTAGES[w.slug] ?? []).map((o) => ({ s: now - o.ago, e: o.open ? null : now - o.ago + o.dur, reason: o.reason, code: o.code ?? null }));

    // Pannes : ce sont elles qui fondent le calcul de disponibilité.
    for (const o of outs) {
      const id = await dbm.openOutage(w.id, o.s, o.reason, o.code);
      if (o.e) await dbm.closeOutage(id, o.e);
      else outageIds[w.id] = id;
    }

    // Contrôles des 7 derniers jours (courbe, frise, disponibilité 24 h) : un toutes les 15 min, le plus récent il y a 2 min.
    const insCheck = stmt('INSERT INTO checks(watch_id, ts, ok, code, ms, size, hash, error, alerts) VALUES(?,?,?,?,?,?,?,?,0)');
    let last = null;
    if (w.slug !== 'domain') {
      // Du plus ancien au plus récent : l'application ordonne les mesures par identifiant.
      for (let k = Math.floor((7 * D) / every); k >= 0; k--) {
        const ts = now - 2 * MIN - k * every;
        const out = outs.find((o) => ts >= o.s && ts < (o.e ?? Infinity));
        if (out) await insCheck.run(w.id, ts, 0, out.code, null, null, null, out.reason);
        else {
          const hour = new Date(ts).getHours();
          let ms = w.ms * (1 + 0.22 * Math.sin(((hour - 15) / 24) * 2 * Math.PI)) * (1 + (r() - 0.5) * 0.35);
          if (r() < 0.025) ms *= 2.4;
          await insCheck.run(w.id, ts, 1, 200, Math.round(ms), 41000 + Math.round(r() * 6000), sha1(`${w.slug}-${Math.floor(ts / D)}`), null);
        }
        if (k === 0) last = { ts, out };
      }
    } else {
      for (let k = Math.floor((7 * D) / H); k >= 0; k--) await insCheck.run(w.id, now - 2 * MIN - k * H, 1, null, null, null, null, null);
      last = { ts: now - 2 * MIN, out: null };
    }

    // Agrégats journaliers (90 jours) : réponses 30 / 90 jours.
    const insDay = stmt('INSERT OR REPLACE INTO daily_stats(watch_id, day, n, ok, sum_ms, ms_n, min_ms, max_ms) VALUES(?,?,?,?,?,?,?,?)');
    if (w.slug !== 'domain') {
      const today = Math.floor(now / D);
      for (let d = 0; d < 92; d++) {
        const dayStart = (today - d) * D;
        const span = d === 0 ? now - dayStart : D;
        const n = Math.max(1, Math.round(span / every));
        let down = 0;
        for (const o of outs) down += Math.max(0, Math.min(o.e ?? now, dayStart + D) - Math.max(o.s, dayStart));
        const failed = Math.min(n, Math.round(down / every));
        const ok = n - failed;
        const avg = w.ms * (1 + (r() - 0.5) * 0.3);
        await insDay.run(w.id, today - d, n, ok, Math.round(avg * ok), ok, Math.round(avg * 0.6), Math.round(avg * (2 + r())));
      }
    }

    // État : signaux affichés sur la page du site (DNS, certificat, registre…), incidents actifs.
    const ip = `203.0.113.${10 + w.i}`;
    const ns = ['ns1.dns-hebergeur.example', 'ns2.dns-hebergeur.example'];
    const tlsExpires = now + (w.story === 'tls' ? 9 : 52 + w.i * 6) * D;
    const dns = { a: [ip], aaaa: [`2001:db8:${w.i + 1}::10`], cname: [], zone: root, ns, mx: ['mx1.mail-pro.example', 'mx2.mail-pro.example'],
      caa: ['issue letsencrypt.org'], spf: 'v=spf1 include:_spf.mail-pro.example ~all', dmarc: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${root}` };
    const rdapExpires = now + (w.story === 'domain' ? 21 : 180 + w.i * 37) * D;
    const state = {
      baseline: true, fails: 0, incidents: {}, finalUrl: w.url, server: w.server ?? 'nginx', title: site ? `${site.name} — ${site.hero.title}` : '',
      scripts: [`https://${domainName}/assets/main.js`, `https://${domainName}/assets/vendor.js`, 'https://cdn.exemple-statistiques.example/analytics.js'],
      linkHosts: ['facebook.com', 'linkedin.com', 'maps.exemple-cartes.example'], iframeHosts: [], formHosts: [], metaRefresh: '', suspects: [], seenPrefixes: [`203.0.113`],
      dns, resolvers: { Cloudflare: ns, Google: ns, Quad9: ns },
      rdap: { checkedAt: now - 22 * MIN, registrar: w.registrar, registered: now - (3 + w.i) * 365 * D, expires: rdapExpires, transferred: 0, changed: now - (30 + w.i * 9) * D,
        locked: true, status: ['client transfer prohibited', 'client update prohibited'], nameservers: ns, dnssec: w.dnssec },
    };
    if (REPORT[w.slug]) {
      state.cms = { ...REPORT[w.slug], checkedAt: now - 3 * H, ok: true, error: null };
      for (const i of cmsIncidents(state.cms, { afterDays: 7, now })) state.incidents[i.key] = { severity: i.severity, title: i.title, detail: i.detail, since: now - (AGO[w.slug]?.[i.key] ?? D) };
    }
    if (w.slug !== 'domain') state.tls = { fp: hex(32, 77 + w.i), issuer: "Let's Encrypt", subject: domainName, expires: tlsExpires, authorized: true, protocol: 'TLSv1.3' };

    if (w.story === 'defaced') {
      Object.assign(state, { title: 'HACKED', scripts: [...state.scripts, 'https://cdn.evil-stats.example/p.js'], iframeHosts: ['malware-cdn.example'], forbiddenHits: ['hacked by', 'cyber team', 'greetz to'] });
      state.incidents.forbidden = { severity: 'critical', title: '3 textes suspects détectés : « hacked by », « cyber team », « greetz to »', detail: '…hacked by anonymous cyber team your security is a joke. greetz to all.…', since: now - 36 * MIN };
    }
    if (w.story === 'down') {
      Object.assign(state, { fails: 2, failSince: now - 27 * MIN, outageId: outageIds[w.id] });
      state.incidents.down = { severity: 'critical', title: 'Site inaccessible', detail: 'Connexion refusée par le serveur', since: now - 27 * MIN };
    }
    if (w.story === 'tls') state.incidents.tls_expiring = { severity: 'warning', title: 'Le certificat TLS expire dans 9 jour(s)', detail: `Valide jusqu'au ${fmtDate(tlsExpires)}`, since: now - 1 * D };
    if (w.story === 'domain') state.incidents.rdap_expiring = { severity: 'warning', title: 'Le nom de domaine expire dans 21 jour(s)', detail: `${root} · échéance le ${fmtDate(rdapExpires)}`, since: now - 3 * D };

    await db.run('UPDATE watches SET created_at = ?, next_run = ?, last_check = ?, last_code = ?, last_ms = ?, last_error = ?, state = ? WHERE id = ?', [now - 100 * D, now + 11 * MIN, last.ts, last.out ? null : 200, last.out ? null : Math.round(w.ms), last.out ? last.out.reason : null, JSON.stringify(state), w.id]);
  }

  // ── Versions enregistrées (onglet Modifications) : calculées avec le vrai moteur de diff ──
  const snap = async (w, ago, lines, title, prevLines) => {
    const d = prevLines ? diffLines(prevLines, lines) : null;
    const meta = d ? { added: d.added, removed: d.removed, similarity: +d.similarity.toFixed(3), pct: +(((d.added + d.removed) / Math.max(1, prevLines.length + lines.length)) * 100).toFixed(2) } : { baseline: true };
    const id = await dbm.insertSnapshot(w.id, { hash: sha1(lines.join('\n')), lines, title, size: 41000, meta });
    await db.run('UPDATE snapshots SET ts = ? WHERE id = ?', [now - ago, id]);
    return { id, lines, d };
  };
  const snaps = {};
  for (const w of watches.filter((x) => SITES[x.slug])) {
    const s = SITES[w.slug];
    const base = linesOf(s);
    const title = `${s.name} — ${s.hero.title}`;
    const first = await snap(w, 60 * D, base, title);
    snaps[w.slug] = { first };
    if (w.slug === 'dupont') {
      snaps.dupont.promo = await snap(w, 6 * D, linesOf(s, { promo: true }), title, base);
      snaps.dupont.defaced = await snap(w, 37 * MIN, DEFACED_LINES, 'HACKED', snaps.dupont.promo.lines);
    }
    if (w.slug === 'martin') {
      const v2 = base.map((l) => (l.includes('02 41 00 00 00') ? l.replace('02 41 00 00 00', '02 41 00 00 01') : l));
      snaps.martin.v2 = await snap(w, 18 * D, v2, title, base);
      const v3 = [...v2.slice(0, 5), 'Clôture comptable : vos pièces avant le 20 décembre', ...v2.slice(5)];
      snaps.martin.v3 = await snap(w, 3 * D, v3, title, v2);
    }
    if (w.slug === 'nova') snaps.nova.v2 = await snap(w, 5 * D, [...base.slice(0, 5), 'Livraison offerte dès 60 € d\'achat', ...base.slice(5)], title, base);
  }

  // ── Alertes : insérées par ordre chronologique (l'application les affiche par identifiant décroissant) ──
  const W = Object.fromEntries(watches.map((w) => [w.slug, w.id]));
  const dd = snaps.dupont.defaced.d;
  alert(W.dupont, 20 * D, 'critical', 'down', 'Site inaccessible', 'Délai dépassé', { read: 1 });
  alert(W.dupont, 20 * D - 6 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', 'Indisponible pendant 6 min.', { read: 1 });
  alert(W.dupont, 20 * D - 2 * H, 'info', 'tls_renewed', 'Certificat TLS renouvelé', `Nouvelle échéance : ${fmtDate(now + 70 * D)}`, { read: 1 });
  alert(W.dupont, 6 * D, 'warning', 'content_changed', 'Le contenu de la page a changé', `1 ligne(s) ajoutée(s), 0 supprimée(s) · similarité ${Math.round(snaps.dupont.promo.d.similarity * 100)} %`, { snap: snaps.dupont.promo.id, prev: snaps.dupont.first.id, read: 1 });
  alert(W.dupont, 36 * MIN, 'critical', 'content_changed', 'Le contenu de la page a été entièrement remplacé', `${dd.added} ligne(s) ajoutée(s), ${dd.removed} supprimée(s) · similarité ${Math.round(dd.similarity * 100)} %`, { snap: snaps.dupont.defaced.id, prev: snaps.dupont.promo.id });
  alert(W.dupont, 36 * MIN, 'critical', 'forbidden', '3 textes suspects détectés : « hacked by », « cyber team », « greetz to »', '…hacked by anonymous cyber team your security is a joke. greetz to all.…');
  alert(W.dupont, 36 * MIN, 'critical', 'iframe_added', 'Iframe externe injectée dans la page', 'malware-cdn.example');
  alert(W.dupont, 36 * MIN, 'critical', 'script_added', 'Nouveau script externe chargé par la page', 'https://cdn.evil-stats.example/p.js');
  alert(W.dupont, 36 * MIN, 'warning', 'title_changed', 'Le titre de la page a changé', `« ${SITES.dupont.name} — ${SITES.dupont.hero.title} » → « HACKED »`);

  alert(W.martin, 40 * D, 'critical', 'down', 'Site inaccessible', 'Délai dépassé', { read: 1 });
  alert(W.martin, 40 * D - 14 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', 'Indisponible pendant 14 min.', { read: 1 });
  alert(W.martin, 18 * D, 'warning', 'content_changed', 'Le contenu de la page a changé', '1 ligne(s) ajoutée(s), 1 supprimée(s) · similarité 94 %', { snap: snaps.martin.v2.id, prev: snaps.martin.first.id, read: 1 });
  alert(W.martin, 12 * D, 'warning', 'dns_mx', 'Les serveurs de messagerie (MX) ont changé', 'mx1.mail-ancien.example\n→ mx1.mail-pro.example, mx2.mail-pro.example\n\nUn détournement de domaine sert souvent à intercepter les e-mails.', { read: 1 });
  alert(W.martin, 3 * D, 'warning', 'content_changed', 'Le contenu de la page a changé', '1 ligne(s) ajoutée(s), 0 supprimée(s) · similarité 97 %', { snap: snaps.martin.v3.id, prev: snaps.martin.v2.id, read: 1 });

  alert(W.leroy, 46 * D, 'critical', 'http', 'Erreur HTTP 502', 'https://www.garage-leroy.example/ répond 502.', { read: 1 });
  alert(W.leroy, 46 * D - 7 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', 'Indisponible pendant 7 min.', { read: 1 });
  alert(W.leroy, 9 * D, 'critical', 'http', 'Erreur HTTP 503', 'https://www.garage-leroy.example/ répond 503.', { read: 1 });
  alert(W.leroy, 9 * D - 12 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', 'Indisponible pendant 12 min.', { read: 1 });
  alert(W.leroy, 1 * D, 'warning', 'tls_expiring', 'Le certificat TLS expire dans 10 jour(s)', `Valide jusqu'au ${fmtDate(now + 9 * D)}`);

  alert(W.nova, 57 * D, 'critical', 'http', 'Erreur HTTP 503', 'https://www.nova-boutique.example/ répond 503.', { read: 1 });
  alert(W.nova, 57 * D - 38 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', 'Indisponible pendant 38 min.', { read: 1 });
  alert(W.nova, 31 * D, 'critical', 'down', 'Site inaccessible', 'Délai dépassé', { read: 1 });
  alert(W.nova, 31 * D - 4 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', 'Indisponible pendant 4 min.', { read: 1 });
  alert(W.nova, 5 * D, 'info', 'links_added', '2 nouveau(x) domaine(s) externe(s) lié(s)', 'cdn-avis.example, pixel-pub.example', { snap: snaps.nova.v2.id, prev: snaps.nova.first.id, read: 1 });

  alert(W.lumiere, 17 * D, 'critical', 'http', 'Erreur HTTP 503', 'https://www.maison-lumiere.example/ répond 503.', { read: 1 });
  alert(W.lumiere, 17 * D - 125 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', `Indisponible pendant ${fmtDuration(125 * MIN)}.`, { read: 1 });
  alert(W.lumiere, 27 * MIN, 'critical', 'down', 'Site inaccessible', 'Connexion refusée par le serveur');

  alert(W.intranet, 9 * D, 'info', 'server_changed', 'Le logiciel serveur a changé', '« nginx/1.24 » → « nginx/1.26 »', { read: 1 });
  alert(W.wiki, 3 * D, 'critical', 'down', 'Site inaccessible', 'Délai dépassé', { read: 1 });
  // Alerte retenue pendant la maintenance en cours de « Wiki technique » : non envoyée, reprise dans le récapitulatif de fin.
  alert(W.wiki, 14 * MIN, 'warning', 'content_changed', 'Le contenu de la page a changé', '3 ligne(s) ajoutée(s), 2 supprimée(s) · similarité 91 %', { read: 1, maint: 1 });
  // Mises à jour du CMS et fin de support de PHP : titres et détails produits par le vrai code d'alerte.
  for (const [slug, key] of [['martin', 'cms_core'], ['martin', 'cms_updates'], ['nova', 'php_eol']]) {
    const i = incidentAt(slug, key);
    alert(W[slug], AGO[slug][key], i.severity, key, i.title, i.detail);
  }
  alert(W.wiki, 3 * D - 9 * MIN, 'recovery', 'recovery', 'Le site est de nouveau accessible', 'Indisponible pendant 9 min.', { read: 1 });
  alert(W.domain, 3 * D, 'warning', 'rdap_expiring', 'Le nom de domaine expire dans 21 jour(s)', `exemple-societe.example · échéance le ${fmtDate(now + 21 * D)}`);

  const insAlert = stmt('INSERT INTO alerts(watch_id, ts, severity, type, title, detail, snapshot_id, prev_snapshot_id, read, notified, maintenance) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for (const a of alerts.sort((x, y) => x.ts - y.ts)) await insAlert.run(a.w, a.ts, a.sev, a.type, a.title, a.detail, a.snap ?? null, a.prev ?? null, a.read ?? 0, a.sev === 'info' || a.maint ? 0 : 1, a.maint ?? 0);
  await db.exec('COMMIT');

  // ── Maintenance : une fenêtre en cours et une prévue demain, sur « Wiki technique » ──
  await dbm.addMaintenance({ watchId: W.wiki, start: now - 20 * MIN, end: now + 40 * MIN, note: 'Mise à jour du serveur de sauvegarde' });
  await dbm.addMaintenance({ watchId: W.wiki, start: now + 20 * H, end: now + 21 * H, note: 'Renouvellement du certificat' });

  // ── Captures d'écran enregistrées (images réelles des faux sites) ──
  const SHOTS = join(dataDir, 'screenshots');
  const putShot = async (w, ago, kind, img) => {
    const ts = now - ago;
    mkdirSync(join(SHOTS, String(w.id)), { recursive: true });
    const file = `${w.id}/${ts}.jpg`, thumb = `${w.id}/${ts}.t.jpg`;
    writeFileSync(join(SHOTS, file), img.image);
    writeFileSync(join(SHOTS, thumb), img.thumb);
    await dbm.insertScreenshot({ watchId: w.id, ts, kind, file, thumb, size: img.image.length, width: 1280, height: 800 });
  };
  for (const w of canShoot ? watches.filter((x) => SITES[x.slug]) : []) {
    const normal = images[w.slug];
    const times = w.slug === 'dupont' ? [60, 120, 180, 240, 300] : [20, 80, 140, 200];
    // Insérées de la plus ancienne à la plus récente : l'application ordonne les captures par identifiant.
    const shots = times.map((m) => ({ ago: m * MIN, kind: 'scheduled', img: normal }));
    if (w.slug === 'dupont') shots.push({ ago: 37 * MIN, kind: 'alert', img: images.dupontDefaced }, { ago: 9 * H, kind: 'manual', img: normal });
    for (const s of shots.sort((a, b) => b.ago - a.ago)) await putShot(w, s.ago, s.kind, s.img);
    await dbm.setShotState(w.id, { nextShot: now + 38 * MIN, error: w.slug === 'lumiere' ? 'Connexion refusée par le serveur' : null });
  }

  await db.close?.();
  return { watches, groups: gid, now, images };
}
