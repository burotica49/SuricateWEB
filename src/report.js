// Rapport mensuel client et page de statut publique : deux documents HTML autonomes, sans JavaScript d'affichage.
//
// Données (disponibilité, pannes, alertes, mises à jour) → `siteReport()` ; mise en page → `renderReport()` et `renderStatusPage()`.
// Les fuseaux horaires sont donnés en minutes de décalage avec UTC (+60 pour Paris en hiver), comme pour les barres de disponibilité.
import {
  DAY_MS, alertsBetween, currentOutage, uptimeBetween, uptimeSummary, uptimeBars, outageList, outagesBetween, maintenanceBetween, listMaintenance, responseBetween,
} from './db.js';
import { phpSupport } from './cms-alerts.js';
import { esc, fmtDuration } from './util.js';

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Décalage du serveur lui-même (minutes par rapport à UTC), quand le navigateur n'en transmet pas. */
export const serverTz = () => -new Date().getTimezoneOffset();

/** Un jour local en texte, à partir d'un horodatage UTC et du décalage. */
const local = (t, tz) => new Date(t + tz * 60e3);
const fmtDate = (t, tz) => local(t, tz).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDateTime = (t, tz) => local(t, tz).toLocaleString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtShort = (t, tz) => local(t, tz).toLocaleString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Disponibilité tronquée, jamais arrondie vers le haut (99,9996 % ne doit pas s'afficher « 100 % »). */
export function fmtPct(u) {
  if (u == null) return '—';
  const f = u >= 99 ? Math.floor(u * 1000) / 1000 : Math.floor(u * 100) / 100;
  return `${(f >= 100 ? '100' : f.toFixed(u >= 99 ? 3 : 2)).replace('.', ',')} %`;
}

const fmtMs = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2).replace('.', ',')} s` : `${Math.round(n)} ms`);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/**
 * Mois demandé (« 2026-10 ») → bornes en ms UTC. Sans mois : le dernier mois entier.
 * `now` borne la fin (mois en cours). Retourne null si le mois est invalide ou dans le futur.
 */
export function monthRange(month, tz = 0, now = Date.now()) {
  const off = tz * 60e3;
  const here = local(now, tz);
  let y = here.getUTCFullYear();
  let m = here.getUTCMonth();
  if (month === undefined || month === null || month === '') {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  } else {
    const mm = /^(\d{4})-(\d{2})$/.exec(String(month));
    if (!mm) return null;
    y = Number(mm[1]);
    m = Number(mm[2]) - 1;
    if (m < 0 || m > 11 || y < 2000 || y > 2100) return null;
  }
  const from = Date.UTC(y, m, 1) - off;
  const to = Date.UTC(y, m + 1, 1) - off;
  if (from > now) return null;
  const key = `${y}-${String(m + 1).padStart(2, '0')}`;
  const prev = m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
  const next = m === 11 ? `${y + 1}-01` : `${y}-${String(m + 2).padStart(2, '0')}`;
  return { key, from, to, label: `${MONTHS[m]} ${y}`, partial: to > now, days: Math.round((to - from) / DAY_MS), prev, next: to > now ? null : next, tz };
}

const overlap = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/** Toutes les données d'un site pour une période [from, to[. */
export function siteReport(w, range, now = Date.now()) {
  const { from, to } = range;
  const end = Math.min(to, now);
  const domainOnly = w.config.mode === 'domain';
  const out = { id: w.id, name: w.name, url: w.url, host: safeHost(w.url), domainOnly, since: w.createdAt, monitoredFrom: Math.max(from, w.createdAt) };
  if (domainOnly) {
    out.uptime = null;
  } else {
    const u = uptimeBetween(w, from, end, now);
    out.uptime = u.uptime;
    out.downtime = u.downtime;
    out.outageCount = u.outages;
    out.outages = outagesBetween(w.id, from, to, now).map((o) => ({ start: o.start, end: o.ongoing ? null : o.end, duration: o.duration, ongoing: o.ongoing, startedBefore: o.startedBefore }));
    out.longest = out.outages.reduce((m, o) => Math.max(m, o.duration), 0);
    out.response = responseBetween(w.id, from, to);
    out.days = [];
    for (let t = from; t < end; t += DAY_MS) {
      const d = t + DAY_MS <= w.createdAt ? { uptime: null } : uptimeBetween(w, t, Math.min(t + DAY_MS, end), now);
      out.days.push({ from: t, uptime: d.uptime, outages: d.outages ?? 0, downtime: d.downtime ?? 0 });
    }
  }
  const maint = maintenanceBetween(w.id, from, to);
  out.maintenance = maint.map((m) => ({ start: m.start, end: m.end, note: m.note }));
  out.maintenanceMs = maint.reduce((s, m) => s + overlap(m.start, m.end, from, end), 0);

  // Alertes de la période (hors rétablissements et récapitulatifs de maintenance) : titres seulement, jamais le détail technique.
  const rows = alertsBetween(w.id, from, to);
  out.alerts = { critical: rows.filter((r) => r.severity === 'critical').length, warning: rows.filter((r) => r.severity === 'warning').length, items: rows.slice(0, 15) };
  out.alerts.total = rows.length;

  const cms = w.state.cms;
  if (!domainOnly && w.config.cms.type && cms?.core) {
    const pending = [
      ...(cms.core?.available ? [{ kind: 'core', name: w.config.cms.type === 'prestashop' ? 'PrestaShop' : 'WordPress', current: cms.core.current, available: cms.core.available }] : []),
      ...(cms.extensions || []).filter((e) => e.available).map((e) => ({ kind: 'ext', name: e.name, current: e.current, available: e.available })),
      ...(cms.themes || []).filter((e) => e.available).map((e) => ({ kind: 'theme', name: e.name, current: e.current, available: e.available })),
    ];
    const integ = cms.integrity;
    const issues = integ?.core ? countIssues(integ) : null;
    out.cms = {
      type: w.config.cms.type, version: cms.cmsVersion || cms.core?.current || null, php: cms.php || null, phpSupport: phpSupport(cms.php, now),
      checkedAt: cms.checkedAt || null, pending,
      applied: (cms.history || []).filter((h) => h.ts >= from && h.ts < to),
      integrity: integ?.checkedAt && integ.core ? { checkedAt: integ.checkedAt, issues, partial: !!integ.partial || !integ.core.known } : null,
      admins: cms.admins ? { count: cms.admins.count, flagged: (cms.admins.added?.length || 0) + (cms.admins.extra || 0) } : null,
    };
  }
  out.tlsExpires = w.state.tls?.expires || null;
  out.domainExpires = w.state.rdap?.expires || null;
  return out;
}

const safeHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function countIssues(integ) {
  const n = (s) => (s?.modified?.length || 0) + (s?.added?.length || 0);
  return n(integ.core) + (integ.plugins || []).reduce((t, p) => t + n(p), 0) + (integ.uploads?.php?.length || 0);
}

// ───────────── Mise en page ─────────────

const CSS = `
:root{--bg:#f4f5f8;--card:#fff;--ink:#1b1f2a;--mute:#667085;--line:#e4e7ec;--ok:#12805c;--warn:#b54708;--bad:#c01048;--info:#175cd3;--okbg:#d1fadf;--warnbg:#fef0c7;--badbg:#fee4e2;--none:#d0d5dd;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#181b24;--ink:#e8eaf0;--mute:#98a2b3;--line:#2a2f3c;--ok:#47cd89;--warn:#fdb022;--bad:#f97066;--info:#84adff;--okbg:#0a3d2a;--warnbg:#4a3205;--badbg:#4a1420;--none:#3a4050;--accent:#8b8bf5}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 56px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}h3{font-size:15px;margin:18px 0 8px}
p{margin:0 0 10px}.mute{color:var(--mute)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 16px}
.head{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-start;margin-bottom:18px}
.nav{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn{display:inline-block;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);text-decoration:none;font:inherit;font-size:13px;cursor:pointer}
.btn:hover{border-color:var(--accent)}.btn[aria-disabled=true]{opacity:.45;pointer-events:none}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:6px}
.stat{border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:22px;line-height:1.2}.stat span{font-size:13px;color:var(--mute)}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.mute{background:var(--line);color:var(--mute)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);font-weight:600}
td.r,th.r{text-align:right}tr:last-child td{border-bottom:0}
.bars{display:flex;gap:2px;height:34px;align-items:stretch;margin:8px 0 4px}.bars i{flex:1;min-width:2px;border-radius:2px;background:var(--ok)}
.bars i.warn{background:var(--warn)}.bars i.bad{background:var(--bad)}.bars i.none{background:var(--none)}
.legend{display:flex;justify-content:space-between;font-size:12px;color:var(--mute)}
ul.plain{margin:0;padding-left:18px}ul.plain li{margin:2px 0}
.empty{color:var(--mute);font-style:italic}
.big{display:flex;align-items:center;gap:14px;margin-bottom:6px}.big .dot{width:16px;height:16px;border-radius:50%;flex:none}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}.dot.mute{background:var(--none)}
footer{margin-top:28px;font-size:12px;color:var(--mute);text-align:center}
.site{break-inside:auto}.sep{break-before:page}
@media print{:root{--bg:#fff;--card:#fff;--ink:#1b1f2a;--mute:#667085;--line:#e4e7ec;--ok:#12805c;--warn:#b54708;--bad:#c01048;--okbg:#d1fadf;--warnbg:#fef0c7;--badbg:#fee4e2;--none:#d0d5dd}body{background:#fff;font-size:12.5px}main{padding:0;max-width:none}.card{break-inside:avoid;border-color:#ccc}.noprint{display:none!important}.sep{break-before:page}.sep:first-of-type{break-before:auto}}
`;

const page = ({ title, body, head = '', refresh = 0, bodyClass = '' }) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)}</title><style>${CSS}</style>${head}</head><body class="${bodyClass}"><main>${body}</main></body></html>`;

const barCls = (u) => (u == null ? 'none' : u >= 99.9 ? '' : u >= 95 ? 'warn' : 'bad');
const upPill = (u) => (u == null ? '<span class="pill mute">—</span>' : `<span class="pill ${u >= 99.9 ? 'ok' : u >= 99 ? 'warn' : 'bad'}">${fmtPct(u)}</span>`);

function dayBars(days, tz) {
  return `<div class="bars" role="img" aria-label="Disponibilité jour par jour">${days.map((d) => {
    const when = local(d.from, tz).toLocaleDateString('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
    const t = d.uptime == null ? `${when} — pas de donnée` : `${when} — ${fmtPct(d.uptime)}${d.outages ? ` · ${plural(d.outages, 'panne', 'pannes')} (${fmtDuration(d.downtime)})` : ' · aucune panne'}`;
    return `<i class="${barCls(d.uptime)}" title="${esc(t)}"></i>`;
  }).join('')}</div>`;
}

function outageTable(list, tz) {
  if (!list.length) return '<p class="empty">Aucune panne sur la période.</p>';
  return `<table><thead><tr><th>Début</th><th>Fin</th><th class="r">Durée</th></tr></thead><tbody>${list.map((o) => `<tr>
<td>${esc(o.startedBefore ? `avant le ${fmtDate(o.start, tz)}` : fmtDateTime(o.start, tz))}</td>
<td>${o.ongoing ? '<span class="pill bad">En cours</span>' : esc(fmtDateTime(o.end, tz))}</td>
<td class="r"><b>${esc(fmtDuration(o.duration))}</b></td></tr>`).join('')}</tbody></table>`;
}

const KIND = { core: 'noyau', ext: 'extension', theme: 'thème' };

function cmsSection(c, range, tz) {
  const label = c.type === 'prestashop' ? 'PrestaShop' : 'WordPress';
  const rows = [];
  rows.push(`<p><b>${esc(label)} ${esc(c.version || '')}</b>${c.php ? ` · PHP ${esc(c.php)}` : ''}${c.phpSupport?.status === 'ended' ? ' <span class="pill bad">PHP non maintenu</span>' : c.phpSupport?.status === 'ending' ? ' <span class="pill warn">fin de support de PHP proche</span>' : ''}
<span class="mute small"> · relevé du ${esc(fmtDate(c.checkedAt, tz))}</span></p>`);
  rows.push(`<h3>Mises à jour effectuées ${range.partial ? 'ce mois-ci' : 'sur la période'}</h3>`);
  rows.push(c.applied.length
    ? `<ul class="plain">${c.applied.map((h) => `<li>${esc(h.name)} (${KIND[h.kind] || h.kind}) : ${h.from ? `${esc(h.from)} → ` : 'installée en '}<b>${esc(h.to)}</b> <span class="mute small">· ${esc(fmtDate(h.ts, tz))}</span></li>`).join('')}</ul>`
    : '<p class="empty">Aucune mise à jour détectée sur la période.</p>');
  rows.push('<h3>Mises à jour en attente</h3>');
  rows.push(c.pending.length
    ? `<ul class="plain">${c.pending.slice(0, 12).map((p) => `<li>${esc(p.name)} (${KIND[p.kind]}) : ${esc(p.current || '—')} → <b>${esc(p.available)}</b></li>`).join('')}${c.pending.length > 12 ? `<li class="mute">… et ${c.pending.length - 12} autre(s)</li>` : ''}</ul>`
    : '<p><span class="pill ok">Tout est à jour</span></p>');
  if (c.integrity || c.admins) {
    rows.push('<h3>Sécurité du site</h3><ul class="plain">');
    if (c.integrity) {
      rows.push(`<li>Intégrité des fichiers${c.integrity.partial ? ' (contrôle partiel)' : ''} : ${c.integrity.issues ? `<span class="pill bad">${plural(c.integrity.issues, 'anomalie', 'anomalies')}</span>` : '<span class="pill ok">aucune anomalie</span>'} <span class="mute small">· contrôlée le ${esc(fmtDate(c.integrity.checkedAt, tz))}</span></li>`);
    }
    if (c.admins) rows.push(`<li>Comptes administrateurs : ${c.admins.count}${c.admins.flagged ? ` <span class="pill bad">${plural(c.admins.flagged, 'nouveau compte à vérifier', 'nouveaux comptes à vérifier')}</span>` : ' <span class="pill ok">aucun nouveau compte inconnu</span>'}</li>`);
    rows.push('</ul>');
  }
  return `<div class="card"><h2>Mises à jour et sécurité</h2>${rows.join('')}</div>`;
}

function siteSection(s, range, { multi = false } = {}) {
  const tz = range.tz;
  const parts = [];
  parts.push(`<div class="card"><h2>${esc(multi ? s.name : 'Disponibilité')}${multi ? ` <span class="mute small">· ${esc(s.host)}</span>` : ''}</h2>`);
  if (s.domainOnly) {
    parts.push('<p class="mute">Surveillance du nom de domaine seul : pas de mesure de disponibilité du site.</p>');
  } else {
    parts.push(`<div class="stats">
<div class="stat"><b>${fmtPct(s.uptime)}</b><span>Disponibilité</span></div>
<div class="stat"><b>${s.outageCount ? esc(fmtDuration(s.downtime)) : '0'}</b><span>Indisponibilité cumulée</span></div>
<div class="stat"><b>${s.outageCount}</b><span>${s.outageCount > 1 ? 'Pannes' : 'Panne'}${s.longest ? ` · la plus longue : ${esc(fmtDuration(s.longest))}` : ''}</span></div>
<div class="stat"><b>${esc(fmtMs(s.response.avg))}</b><span>Temps de réponse moyen</span></div></div>`);
    if (s.monitoredFrom > range.from) parts.push(`<p class="mute small">Surveillance démarrée le ${esc(fmtDate(s.monitoredFrom, tz))} : la période est comptée à partir de cette date.</p>`);
    parts.push(dayBars(s.days, tz));
    parts.push(`<div class="legend"><span>${esc(fmtDate(range.from, tz))}</span><span>${esc(fmtDate(Math.min(range.to, Date.now()) - 1, tz))}</span></div>`);
    parts.push('<h3>Pannes</h3>', outageTable(s.outages, tz));
  }
  if (s.maintenance.length) {
    parts.push(`<h3>Maintenances planifiées <span class="mute small">· ${esc(fmtDuration(s.maintenanceMs))}</span></h3><ul class="plain">${s.maintenance.map((m) => `<li>${esc(fmtShort(m.start, tz))} → ${esc(fmtShort(m.end, tz))}${m.note ? ` · ${esc(m.note)}` : ''}</li>`).join('')}</ul><p class="mute small">Une maintenance n'est pas comptée comme une indisponibilité.</p>`);
  }
  parts.push('</div>');

  parts.push(`<div class="card"><h2>Incidents détectés</h2>${s.alerts.total
    ? `<p>${s.alerts.critical ? `<span class="pill bad">${plural(s.alerts.critical, 'critique', 'critiques')}</span> ` : ''}${s.alerts.warning ? `<span class="pill warn">${plural(s.alerts.warning, 'avertissement', 'avertissements')}</span>` : ''}</p>
<table><tbody>${s.alerts.items.map((a) => `<tr><td style="white-space:nowrap">${esc(fmtShort(a.ts, tz))}</td><td>${esc(a.title)}</td></tr>`).join('')}</tbody></table>${s.alerts.total > s.alerts.items.length ? `<p class="mute small">… et ${s.alerts.total - s.alerts.items.length} autre(s).</p>` : ''}`
    : '<p><span class="pill ok">Aucun incident</span> <span class="mute">Aucune anomalie détectée sur la période.</span></p>'}</div>`);

  if (s.cms) parts.push(cmsSection(s.cms, range, tz));

  const certs = [];
  if (s.tlsExpires) certs.push(`Certificat TLS valide jusqu'au <b>${esc(fmtDate(s.tlsExpires, tz))}</b>`);
  if (s.domainExpires) certs.push(`Nom de domaine renouvelable avant le <b>${esc(fmtDate(s.domainExpires, tz))}</b>`);
  if (certs.length) parts.push(`<div class="card"><h2>Échéances</h2><ul class="plain">${certs.map((c) => `<li>${c}</li>`).join('')}</ul></div>`);
  return parts.join('\n');
}

/**
 * Rapport HTML : un site, ou plusieurs (un groupe) avec un tableau de synthèse.
 * `nav` : { base } adresse de la page sans le paramètre « month », pour les liens mois précédent / suivant.
 */
export function renderReport({ title, sites, range, nav, generatedAt = Date.now(), appName = 'VigieWeb' }) {
  const tz = range.tz;
  const multi = sites.length > 1;
  const link = (month, text, cls = '') => (month ? `<a class="btn ${cls}" href="${esc(`${nav.base}${nav.base.includes('?') ? '&' : '?'}month=${month}&tz=${tz}`)}">${text}</a>` : `<a class="btn" aria-disabled="true">${text}</a>`);
  const head = `<div class="head"><div><h1>Rapport mensuel — ${esc(range.label)}</h1><p class="mute">${esc(title)}${range.partial ? ' · mois en cours (jusqu’à ce jour)' : ''}</p></div>
<div class="nav noprint">${link(range.prev, '← Mois précédent')}${link(range.next, 'Mois suivant →')}<button class="btn" type="button" data-print>Imprimer / PDF</button></div></div>`;
  const summary = multi ? `<div class="card"><h2>Synthèse</h2><table><thead><tr><th>Site</th><th class="r">Disponibilité</th><th class="r">Pannes</th><th class="r">Incidents</th><th class="r">Mises à jour en attente</th></tr></thead><tbody>${sites.map((s) => `<tr>
<td><b>${esc(s.name)}</b><br><span class="mute small">${esc(s.host)}</span></td><td class="r">${upPill(s.uptime)}</td><td class="r">${s.domainOnly ? '—' : s.outageCount}</td><td class="r">${s.alerts.total}</td><td class="r">${s.cms ? s.cms.pending.length : '—'}</td></tr>`).join('')}</tbody></table></div>` : '';
  const body = sites.map((s, i) => `<section class="site ${multi && i ? 'sep' : ''}">${multi ? `<h1 style="font-size:20px;margin:${i ? 0 : 6}px 0 12px">${esc(s.name)}</h1>` : ''}${siteSection(s, range, { multi: false })}</section>`).join('\n');
  const foot = `<footer>Rapport généré par ${esc(appName)} le ${esc(fmtDateTime(generatedAt, tz))}. Période : du ${esc(fmtDate(range.from, tz))} au ${esc(fmtDate(Math.min(range.to, generatedAt) - 1, tz))}.</footer>`;
  return page({ title: `Rapport ${range.label} — ${title}`, body: head + summary + body + foot, head: '<script src="/report.js" defer></script>' });
}

// ───────────── Page de statut publique ─────────────

/** Ce que la page publique montre : disponibilité, pannes, maintenances. Jamais d'alerte de sécurité ni de détail technique. */
export function statusData(w, tz = 0, now = Date.now()) {
  const open = currentOutage(w.id);
  const maint = listMaintenance(w.id, now);
  const active = maint.find((m) => m.start <= now) || null;
  let state = 'up';
  if (!w.enabled) state = 'paused';
  else if (active) state = 'maintenance';
  else if (open) state = 'down';
  return {
    state, since: open?.start ?? null, maintenance: maint.slice(0, 5), active,
    periods: uptimeSummary(w, now), bars: uptimeBars(w, tz, now, 90),
    outages: outageList(w.id, 90, now).filter((o) => (o.end ?? now) > now - 90 * DAY_MS).slice(0, 15),
    checkedAt: w.lastCheck,
  };
}

const STATE = {
  up: ['ok', 'Tous les systèmes fonctionnent normalement'],
  down: ['bad', 'Panne en cours'],
  maintenance: ['warn', 'Maintenance en cours'],
  paused: ['mute', 'Surveillance en pause'],
};

export function renderStatusPage({ title, host, data, tz = 0, now = Date.now() }) {
  const [cls, text] = STATE[data.state];
  const per = (k, l) => `<div class="stat"><b>${fmtPct(data.periods[k].uptime)}</b><span>${l}</span></div>`;
  const body = `<div class="card"><div class="big"><span class="dot ${cls}"></span><div><h1 style="margin:0">${esc(title)}</h1><div class="mute small">${esc(host)}</div></div></div>
<p style="margin:14px 0 0"><span class="pill ${cls}">${esc(text)}</span>${data.state === 'down' && data.since ? ` <span class="mute">depuis ${esc(fmtShort(data.since, tz))} (${esc(fmtDuration(now - data.since))})</span>` : ''}${data.state === 'maintenance' && data.active ? ` <span class="mute">jusqu'à ${esc(fmtShort(data.active.end, tz))}${data.active.note ? ` · ${esc(data.active.note)}` : ''}</span>` : ''}</p></div>
<div class="card"><h2>Disponibilité</h2><div class="stats">${per('24h', '24 heures')}${per('7d', '7 jours')}${per('30d', '30 jours')}${per('90d', '90 jours')}</div>
${dayBars(data.bars, tz)}<div class="legend"><span>Il y a 90 jours</span><span>Aujourd'hui</span></div></div>
${data.maintenance.length ? `<div class="card"><h2>Maintenances</h2><ul class="plain">${data.maintenance.map((m) => `<li>${esc(fmtShort(m.start, tz))} → ${esc(fmtShort(m.end, tz))}${m.note ? ` · ${esc(m.note)}` : ''}</li>`).join('')}</ul></div>` : ''}
<div class="card"><h2>Pannes des 90 derniers jours</h2>${outageTable(data.outages.map((o) => ({ start: o.start, end: o.end, duration: o.duration, ongoing: o.ongoing })), tz)}</div>
<footer>Mis à jour le ${esc(fmtDateTime(data.checkedAt || now, tz))} · cette page se rafraîchit toute seule.</footer>`;
  return page({ title: `État de ${title}`, body, refresh: 60 });
}
