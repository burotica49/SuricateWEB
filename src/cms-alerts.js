// Alertes tirées du relevé du plugin WordPress / PrestaShop : mises à jour qui tardent, PHP en fin de support.
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
 * Elle repart de zéro si une version encore plus récente sort (l'ancienneté est celle de VigieWeb : le premier relevé
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

const label = { wordpress: 'WordPress', prestashop: 'PrestaShop' };
const KIND = { wordpress: { ext: 'extension', theme: 'thème' }, prestashop: { ext: 'module', theme: 'thème' } };

/**
 * Incidents à déclarer pour ce relevé : { key, severity, title, detail }.
 * `afterDays` : ancienneté à partir de laquelle une mise à jour en attente est signalée.
 */
export function cmsIncidents(report, { afterDays = 7, now = Date.now() } = {}) {
  const out = [];
  if (!report) return out;
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
