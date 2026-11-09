// Alertes tirées du relevé du plugin WordPress / PrestaShop : mises à jour qui tardent, PHP en fin de support,
// intégrité des fichiers et nouveaux comptes administrateurs.
// Fonctions pures (aucun accès à la base ni au réseau) : le moteur de contrôle (checker.js) les applique au dernier relevé.

const DAY = 86400e3;

/**
 * Fin du support de sécurité de chaque branche de PHP (après cette date, plus aucun correctif de sécurité n'est publié).
 * Source : https://www.php.net/supported-versions.php — à relire une fois par an et à compléter à chaque nouvelle branche.
 * Une branche plus récente que la dernière ligne de ce tableau n'est jamais signalée.
 */
export const PHP_SECURITY_END = {
  '5.6': '2018-12-31', '7.0': '2018-12-03', '7.1': '2019-12-01', '7.2': '2020-11-30', '7.3': '2021-12-06', '7.4': '2022-11-28',
  '8.0': '2023-11-26', '8.1': '2025-12-31', '8.2': '2026-12-31', '8.3': '2027-12-31', '8.4': '2028-12-31', '8.5': '2029-12-31',
};

/** Nombre de jours avant la fin du support à partir duquel on prévient. */
export const PHP_WARN_DAYS = 90;
/** Ancienneté (jours) à partir de laquelle une mise à jour du noyau devient critique. */
export const CORE_CRITICAL_DAYS = 30;

// En UTC : les dates du tableau sont des jours calendaires, elles ne doivent pas glisser d'un jour selon le fuseau du serveur.
const dateFr = (t) => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'UTC' });
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/**
 * État du support de sécurité d'une version de PHP.
 * @returns {{ branch: string, status: 'ended'|'ending'|'ok'|'unknown', endsAt: number|null, days: number|null }|null}
 */
export function phpSupport(version, now = Date.now()) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return null;
  const branch = `${Number(m[1])}.${Number(m[2])}`;
  const end = PHP_SECURITY_END[branch];
  if (!end) {
    const [major, minor] = [Number(m[1]), Number(m[2])];
    const [firstMajor, firstMinor] = Object.keys(PHP_SECURITY_END)[0].split('.').map(Number);
    const older = major < firstMajor || (major === firstMajor && minor < firstMinor);
    // Une branche absente du tableau : trop ancienne (terminée) ou trop récente (on ne sait pas encore).
    return { branch, status: older ? 'ended' : 'unknown', endsAt: null, days: null };
  }
  const endsAt = Date.parse(`${end}T23:59:59Z`);
  const days = Math.floor((endsAt - now) / DAY);
  return { branch, status: endsAt < now ? 'ended' : days <= PHP_WARN_DAYS ? 'ending' : 'ok', endsAt, days };
}

const itemKey = (kind, it) => `${kind}:${it.slug || it.name}`;

/**
 * Date à laquelle chaque mise à jour a été vue pour la première fois : `since` sur le noyau et sur chaque élément.
 * Elle repart de zéro si une version encore plus récente sort (l'ancienneté est celle de SuricateWeb : le premier relevé
 * qui voit la mise à jour, pas sa date de publication, que les CMS ne communiquent pas).
 */
export function carrySince(prev, report, now = Date.now()) {
  const old = new Map();
  if (prev?.core?.available && prev.core.since) old.set('core', prev.core);
  for (const [kind, list] of [['ext', prev?.extensions], ['theme', prev?.themes]]) {
    for (const it of list || []) if (it.available && it.since) old.set(itemKey(kind, it), it);
  }
  const stamp = (key, it) => {
    if (!it) return;
    if (!it.available) { delete it.since; return; }
    const was = old.get(key);
    it.since = was && was.available === it.available ? was.since : now;
  };
  stamp('core', report.core);
  for (const it of report.extensions || []) stamp(itemKey('ext', it), it);
  for (const it of report.themes || []) stamp(itemKey('theme', it), it);
  return report;
}

/** Une mise à jour effectuée (version installée différente d'un relevé à l'autre) est conservée ~13 mois pour le rapport mensuel. */
const HISTORY_MAX = 200;
const HISTORY_DAYS = 400;

/**
 * Journal des mises à jour appliquées : { ts, kind: 'core'|'ext'|'theme', name, slug, from, to }.
 * La date est celle du relevé qui a vu la nouvelle version (à l'intervalle du relevé près).
 */
export function carryHistory(prev, report, now = Date.now()) {
  const history = (prev?.history || []).filter((h) => h && now - h.ts < HISTORY_DAYS * DAY);
  if (prev?.core?.current || prev?.extensions?.length || prev?.themes?.length) {
    const was = (kind, list) => new Map((list || []).map((it) => [itemKey(kind, it), it]));
    if (prev.core?.current && report.core?.current && prev.core.current !== report.core.current) {
      history.push({ ts: now, kind: 'core', name: label[report.cms] || 'CMS', slug: '', from: prev.core.current, to: report.core.current });
    }
    for (const [kind, list, before] of [['ext', report.extensions, was('ext', prev.extensions)], ['theme', report.themes, was('theme', prev.themes)]]) {
      for (const it of list || []) {
        const old = before.get(itemKey(kind, it));
        if (!it.current) continue;
        if (!old) history.push({ ts: now, kind, name: it.name, slug: it.slug, from: null, to: it.current });
        else if (old.current && old.current !== it.current) history.push({ ts: now, kind, name: it.name, slug: it.slug, from: old.current, to: it.current });
      }
    }
  }
  report.history = history.slice(-HISTORY_MAX);
  return report;
}

/**
 * Comptes administrateurs : un nouvel administrateur est un classique après une intrusion.
 * Le relevé donne un compteur et les créations récentes ; SuricateWeb garde la référence (`known`, `baseCount`) jusqu'à ce
 * que l'utilisateur déclare connaître les comptes. Le premier relevé fixe la référence sans alerter.
 *   added : créations récentes absentes de la référence · extra : comptes en plus sans création récente (compte promu ?).
 */
export function carryAdmins(prev, report, now = Date.now()) {
  const cur = report.admins;
  if (!cur || cur.count == null) {
    delete report.admins;
    return report;
  }
  const old = prev?.admins;
  if (!old || !Array.isArray(old.known)) {
    report.admins = { ...cur, known: cur.recent.map((r) => r.id).slice(0, 200), baseCount: cur.count, added: [], extra: 0 };
    return report;
  }
  const known = new Set(old.known);
  const baseCount = Math.min(old.baseCount ?? cur.count, cur.count);
  const room = Math.max(0, cur.count - baseCount);
  const added = cur.recent.filter((r) => !known.has(r.id)).map((r) => ({ ...r, since: old.added?.find((a) => a.id === r.id)?.since ?? now }));
  // Un compte créé il y a plus de 30 jours sort de la liste « récente » mais reste un compte en trop : on le garde tant que le compteur le montre.
  for (const a of old.added || []) if (added.length < room && !added.some((x) => x.id === a.id)) added.push(a);
  report.admins = { ...cur, known: old.known, baseCount, added, extra: Math.max(0, room - added.length) };
  return report;
}

/** L'utilisateur déclare connaître les comptes actuels : nouvelle référence, plus d'alerte. */
export function acceptAdmins(admins) {
  if (!admins) return admins;
  const known = [...new Set([...(admins.known || []), ...(admins.recent || []).map((r) => r.id), ...(admins.added || []).map((a) => a.id)])];
  return { ...admins, known: known.slice(-200), baseCount: admins.count, added: [], extra: 0 };
}

const label = { wordpress: 'WordPress', prestashop: 'PrestaShop' };
const KIND = { wordpress: { ext: 'extension', theme: 'thème' }, prestashop: { ext: 'module', theme: 'thème' } };

/** Groupe d'un incident CMS : « security » (intégrité, administrateurs) ou « updates » (versions, PHP). */
export const cmsIncidentGroup = (key) => (/^cms_(integrity|admins)/.test(key) ? 'security' : 'updates');

const fmtDay = (t) => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'UTC' });
const bullets = (lines, max = 8) => [...lines.slice(0, max), ...(lines.length > max ? [`… et ${lines.length - max} autre(s)`] : [])];

/** Fichiers modifiés / ajoutés / manquants d'une section d'intégrité, en lignes lisibles. */
function fileLines(sec, prefix = '') {
  return [
    ...(sec.modified || []).map((f) => `• ${prefix}${f} (modifié)`),
    ...(sec.added || []).map((f) => `• ${prefix}${f} (fichier PHP ajouté)`),
    ...(sec.missing || []).map((f) => `• ${prefix}${f} (manquant)`),
  ];
}

const sectionParts = (sec) => [
  sec.modified?.length ? plural(sec.modified.length, 'fichier modifié', 'fichiers modifiés') : '',
  sec.added?.length ? plural(sec.added.length, 'fichier PHP ajouté', 'fichiers PHP ajoutés') : '',
  sec.missing?.length ? plural(sec.missing.length, 'fichier manquant', 'fichiers manquants') : '',
].filter(Boolean);

/** Incidents d'intégrité des fichiers : noyau, extensions du dépôt officiel, PHP dans les dossiers de médias. */
function integrityIncidents(report) {
  const out = [];
  const integ = report.integrity;
  if (!integ) return out;
  const cms = label[report.cms] || 'Le CMS';
  const tail = 'Ces fichiers ne correspondent pas aux sommes de contrôle publiées par wordpress.org. Si vous ne les avez pas modifiés vous-même, le site est peut-être compromis : comparez avec une sauvegarde saine.';

  const core = integ.core;
  if (core?.known) {
    const parts = sectionParts(core);
    if (parts.length) {
      const bad = core.modified?.length || core.added?.length;
      const n = (core.modified?.length || 0) + (core.added?.length || 0) + (core.missing?.length || 0);
      out.push({
        key: 'cms_integrity_core',
        severity: bad ? 'critical' : 'warning',
        title: `Noyau ${cms} : ${parts.join(', ')}`,
        detail: [...bullets(fileLines(core)), '', bad ? `${tail} Un fichier PHP ajouté dans le noyau est le plus souvent une porte dérobée.` : 'Des fichiers du noyau ont disparu : site cassé, ou nettoyage excessif.'].join('\n'),
        count: n,
      });
    }
  }

  const flagged = (integ.plugins || []).filter((p) => p.known && (p.modified?.length || p.added?.length || p.missing?.length));
  if (flagged.length) {
    const bad = flagged.some((p) => p.modified?.length || p.added?.length);
    const lines = flagged.flatMap((p) => fileLines(p, `${p.name} : `));
    const names = flagged.slice(0, 3).map((p) => p.name).join(', ');
    out.push({
      key: 'cms_integrity_plugins',
      severity: bad ? 'critical' : 'warning',
      title: `${plural(flagged.length, 'extension', 'extensions')} du dépôt officiel avec des fichiers inattendus : ${names}${flagged.length > 3 ? '…' : ''}`,
      detail: [...bullets(lines), '', bad ? tail : 'Des fichiers de ces extensions ont disparu.'].join('\n'),
      count: lines.length,
    });
  }

  const up = integ.uploads;
  if (up?.php?.length) {
    const shop = report.cms === 'prestashop';
    const where = shop ? "les dossiers d'images et de téléversements (img/, upload/, download/)" : 'le dossier des téléversements (uploads)';
    out.push({
      key: 'cms_integrity_uploads',
      severity: 'critical',
      title: `${plural(up.php.length + (up.more || 0), 'fichier PHP trouvé', 'fichiers PHP trouvés')} dans ${shop ? 'les dossiers de médias' : 'uploads'}`,
      detail: [...bullets(up.php.map((f) => `• ${f}`)), '', `${shop ? 'Ces dossiers' : 'Ce dossier'} ne devrai${shop ? 'ent' : 't'} contenir que des médias : un fichier PHP dans ${where} est presque toujours une porte dérobée déposée après une intrusion.`].join('\n'),
      count: up.php.length + (up.more || 0),
    });
  }
  return out;
}

/** Nouveaux comptes administrateurs depuis la dernière référence. */
function adminIncidents(report) {
  const a = report.admins;
  if (!a || (!a.added?.length && !a.extra)) return [];
  const lines = [
    ...a.added.map((u) => `• ${u.login || `compte n° ${u.id}`}${u.registered ? ` (créé le ${fmtDay(u.registered)})` : ''}`),
    ...(a.extra ? [`• ${plural(a.extra, 'compte administrateur de plus', 'comptes administrateur de plus')}, sans création récente : un compte existant a peut-être été promu`] : []),
  ];
  const n = a.added.length + a.extra;
  return [{
    key: 'cms_admins',
    severity: 'critical',
    title: n === 1 && a.added.length === 1 ? `Nouvel administrateur : ${a.added[0].login || `compte n° ${a.added[0].id}`}` : `${n} ${n > 1 ? 'nouveaux comptes administrateur' : 'nouveau compte administrateur'} (${a.baseCount} → ${a.count})`,
    detail: [...lines, '', "Si vous ne connaissez pas ce compte, supprimez-le et changez les mots de passe. Sinon, cliquez sur « Je connais ces comptes » dans l'onglet Sécurité."].join('\n'),
    count: n,
  }];
}

/**
 * Incidents à déclarer pour ce relevé : { key, severity, title, detail, count? }.
 * `afterDays` : ancienneté à partir de laquelle une mise à jour en attente est signalée.
 * `updates` / `security` : groupes d'alertes actifs (réglables site par site).
 */
export function cmsIncidents(report, { afterDays = 7, now = Date.now(), updates = true, security = true } = {}) {
  if (!report) return [];
  const out = updates ? updateIncidents(report, afterDays, now) : [];
  if (security) out.push(...integrityIncidents(report), ...adminIncidents(report));
  return out;
}

function updateIncidents(report, afterDays, now) {
  const out = [];
  const cms = label[report.cms] || 'Le CMS';
  const days = (since) => Math.max(0, Math.floor((now - since) / DAY));

  const core = report.core;
  if (core?.available && core.since && days(core.since) >= afterDays) {
    const n = days(core.since);
    out.push({
      key: 'cms_core',
      severity: n >= Math.max(CORE_CRITICAL_DAYS, afterDays) ? 'critical' : 'warning',
      title: `${cms} ${core.available} est disponible depuis ${plural(n, 'jour', 'jours')}`,
      detail: `Version installée : ${core.current || '—'}. Les mises à jour du noyau corrigent souvent des failles de sécurité.`,
    });
  }

  const kinds = KIND[report.cms] || KIND.wordpress;
  const late = [];
  for (const [kind, list] of [['ext', report.extensions], ['theme', report.themes]]) {
    for (const it of list || []) {
      if (it.available && it.since && days(it.since) >= afterDays) late.push({ ...it, kind, n: days(it.since) });
    }
  }
  if (late.length) {
    late.sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name), 'fr'));
    const lines = late.slice(0, 8).map((it) => `• ${it.name} (${kinds[it.kind]}${it.active === false ? ', inactif' : ''}) : ${it.current || '—'} → ${it.available} · en attente depuis ${it.n} j`);
    if (late.length > 8) lines.push(`… et ${late.length - 8} autre(s)`);
    out.push({
      key: 'cms_updates',
      severity: 'warning',
      title: `${plural(late.length, 'mise à jour en attente', 'mises à jour en attente')} depuis plus de ${plural(afterDays, 'jour', 'jours')}`,
      detail: lines.join('\n'),
    });
  }

  const php = phpSupport(report.php, now);
  if (php?.status === 'ended') {
    out.push({
      key: 'php_eol',
      severity: 'critical',
      title: `PHP ${php.branch} n'est plus maintenu`,
      detail: `Version installée : ${report.php}. ${php.endsAt ? `Plus aucun correctif de sécurité n'est publié pour cette branche depuis le ${dateFr(php.endsAt)}.` : "Cette branche est trop ancienne pour recevoir des correctifs de sécurité."} Demandez à votre hébergeur de passer à une version encore maintenue.`,
    });
  } else if (php?.status === 'ending') {
    out.push({
      key: 'php_eol',
      severity: 'warning',
      title: `PHP ${php.branch} ne sera plus maintenu le ${dateFr(php.endsAt)}`,
      detail: `Version installée : ${report.php}. Fin du support de sécurité dans ${plural(Math.max(0, php.days), 'jour', 'jours')} : prévoyez le passage à une version plus récente.`,
    });
  }
  return out;
}
