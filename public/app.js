// SuricateWeb — interface. SPA sans framework ni étape de build. Tout texte dynamique passe par textContent (pas d'innerHTML sur des données).

import { buildModel, moveSite, moveGroup, stepSite, stepGroup, sameModel, toPayload, applyModel, describeMove } from './layout.js';

// ───────────── Utilitaires DOM ─────────────
const $ = (s, el = document) => el.querySelector(s);

function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') value = v;
    else if (k === 'for') el.htmlFor = v;
    else if (['checked', 'disabled', 'selected', 'open', 'hidden', 'readOnly'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  if (value !== undefined) el.value = value;
  return el;
};

const ICONS = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="11" r="2.5"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  layers: '<path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
};
const ic = (name) => {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
};

/** Relie chaque <label> d'un .field à son champ (accessibilité : nom accessible + clic sur le libellé). */
let uid = 0;
function linkLabels(root) {
  root.querySelectorAll('.field').forEach((f) => {
    const label = f.querySelector(':scope > label');
    const input = f.querySelector('input:not([type=checkbox]), select, textarea');
    if (!label || !input) return;
    if (!input.id) input.id = `f${++uid}`;
    label.htmlFor = input.id;
  });
}

// ───────────── Formats ─────────────
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
function rel(ts) {
  if (!ts) return '—';
  const s = (ts - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 45) return s < 0 ? "à l'instant" : 'dans un instant';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const dt = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dday = (ts) => (ts ? new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');
const fmtMs = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(2).replace('.', ',') + ' s' : Math.round(n) + ' ms');
const fmtBytes = (n) => (n == null ? '—' : n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(1).replace('.', ',') + ' Ko' : (n / 1048576).toFixed(1).replace('.', ',') + ' Mo');
const daysLeft = (ts) => (ts ? Math.floor((ts - Date.now()) / 864e5) : null);
/** Disponibilité tronquée (jamais arrondie vers le haut : 99,9996 % ne doit pas s'afficher « 100 % »). */
const pct = (u) => {
  if (u == null) return '—';
  const f = u >= 99 ? Math.floor(u * 1000) / 1000 : Math.floor(u * 100) / 100;
  return (f >= 100 ? '100' : f.toFixed(u >= 99 ? 3 : 2)).replace('.', ',') + ' %';
};
/** 45 s · 12 min · 3 h 05 · 2 j 4 h */
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60);
  if (hh < 24) return m % 60 ? `${hh} h ${String(m % 60).padStart(2, '0')}` : `${hh} h`;
  const d = Math.floor(hh / 24);
  return hh % 24 ? `${d} j ${hh % 24} h` : `${d} j`;
};
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** Même construction que src/cms.js : origine du site + chemin fixe du plugin. */
function cmsUrl(siteUrl, type, path) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
    const prefix = String(path || '').trim().replace(/^\/+|\/+$/g, '');
    const base = prefix ? `/${prefix}` : '';
    if (type === 'prestashop') {
      u.pathname = `${base}/modules/suricateweb/status.php`.replace(/\/{2,}/g, '/');
      u.search = '';
    } else {
      u.pathname = `${base}/`.replace(/\/{2,}/g, '/');
      u.search = 'rest_route=/suricateweb/v1/status';
    }
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

const randomToken = () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const cmsPending = (report) => {
  if (!report) return 0;
  return [report.core, ...(report.extensions || []), ...(report.themes || [])].filter((i) => i?.available).length;
};
/** Anomalies de sécurité en cours : fichiers modifiés ou ajoutés, PHP dans les médias, nouveaux administrateurs. */
const cmsSecurityCount = (w) => w.incidents.filter((i) => !i.acked && /^cms_(integrity|admins)/.test(i.key)).reduce((n, i) => n + (i.count || 1), 0);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

const STATUS = {
  ok: { label: 'Intact', cls: 'ok' },
  warning: { label: 'À vérifier', cls: 'warn' },
  critical: { label: 'Alerte', cls: 'crit' },
  down: { label: 'Hors ligne', cls: 'crit' },
  paused: { label: 'En pause', cls: 'mute' },
  pending: { label: 'Premier contrôle…', cls: 'mute' },
};
const statusPill = (w) => h('span', { class: `pill ${STATUS[w.status].cls}` }, h('span', { class: 'dot' }), STATUS[w.status].label);

/** compact : icône seule (dans la liste, où le nom du site doit garder sa place). */
const maintPill = (w, compact = false) => {
  const title = `Maintenance jusqu'à ${dt(w.maintenanceUntil)} : alertes retenues, aucune panne comptée`;
  return compact ? h('span', { class: 'pill info icon-only', title, 'aria-label': title }, ic('wrench')) : h('span', { class: 'pill info', title }, ic('wrench'), 'Maintenance');
};

const avatar = (name) => h('div', { class: 'avatar', style: { background: `hsl(${hue(name)} 52% 46%)` } }, (name.trim()[0] || '?'));

// ───────────── API ─────────────
// view : « groups » (organisation manuelle en groupes) ou « status » (liste à plat, sites en alerte en premier).
const loadView = () => { try { return localStorage.getItem('suricate-view') === 'status' ? 'status' : 'groups'; } catch { return 'groups'; } };
const S = { auth: null, caps: {}, plan: null, watches: [], groups: [], settings: null, filter: 'all', q: '', tag: null, open: new Set(), alertSev: '', view: loadView(), dragging: false };

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Session expirée → retour à l'écran de connexion (sauf pour la connexion elle-même : son erreur s'affiche dans le formulaire).
  if (res.status === 401 && S.auth?.required && path !== '/login') {
    S.auth.authenticated = false;
    boot();
    throw new Error('Session expirée');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Erreur ${res.status}`);
    Object.assign(err, { status: res.status, code: data.code }); // `code` : identifiant stable d'une erreur (ex. needs_2fa), si le serveur en donne un
    throw err;
  }
  return data;
}

function toast(msg, kind = 'ok') {
  const t = h('div', { class: `toast ${kind}` }, ic(kind === 'err' ? 'alert' : 'check'), msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
}
const guard = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, 'err');
  }
};

/** Planifie une fenêtre de maintenance pour un site. Résout true si elle a été enregistrée. */
function maintenanceDialog(w) {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); md.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => e.key === 'Escape' && close(false);
    const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const whenSel = h('select', { class: 'input' }, h('option', { value: 'now' }, 'Maintenant'), h('option', { value: 'later' }, 'À une date et une heure précises'));
    const startAt = h('input', { class: 'input', type: 'datetime-local', value: local(new Date(Math.ceil((Date.now() + 3600e3) / 36e5) * 36e5)) });
    const startField = h('div', { class: 'field' }, h('label', {}, 'Début'), startAt);
    startField.hidden = true;
    whenSel.addEventListener('change', () => { startField.hidden = whenSel.value !== 'later'; });
    const dur = h('select', { class: 'input', value: '60' }, ...[[30, '30 minutes'], [60, '1 heure'], [120, '2 heures'], [240, '4 heures'], [480, '8 heures'], [1440, '24 heures'], [4320, '3 jours']].map(([v, l]) => h('option', { value: String(v) }, l)));
    const note = h('input', { class: 'input', placeholder: 'ex. Mise à jour de WordPress', maxlength: 140 });
    const submit = guard(async () => {
      const body = { minutes: Number(dur.value), note: note.value };
      if (whenSel.value === 'later') {
        const t = new Date(startAt.value).getTime();
        if (!Number.isFinite(t) || t <= Date.now()) throw new Error('Choisissez un début dans le futur, ou « Maintenant ».');
        body.start = t;
      }
      await api(`/watches/${w.id}/maintenance`, { method: 'POST', body });
      close(true);
    });
    const ov = h('div', { class: 'overlay', onclick: () => close(false) });
    const md = h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Planifier une maintenance' },
      h('h2', {}, `Maintenance de « ${w.name} »`),
      h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Pendant la fenêtre, SuricateWeb continue de contrôler le site mais retient ses alertes et ne compte aucune panne. Si quelque chose a été détecté, un seul message récapitulatif part à la fin. La surveillance reprend d\'elle-même.'),
      h('div', { class: 'field' }, h('label', {}, 'Commencer'), whenSel), startField,
      h('div', { class: 'field' }, h('label', {}, 'Durée'), dur),
      h('div', { class: 'field' }, h('label', {}, 'Note (facultatif)'), note),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Annuler'), h('button', { class: 'btn primary', onclick: submit }, 'Démarrer la maintenance')));
    document.body.append(ov, md);
    document.addEventListener('keydown', onKey);
    dur.focus();
  });
}

function confirmDialog({ title, text, confirm = 'Confirmer', danger = false }) {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); md.remove(); resolve(v); };
    const ov = h('div', { class: 'overlay', onclick: () => close(false) });
    const md = h('div', { class: 'modal', role: 'dialog' }, h('h2', {}, title), h('p', {}, text),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Annuler'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, onclick: () => close(true) }, confirm)));
    document.body.append(ov, md);
    $('.btn:last-child', md).focus();
  });
}

// ───────────── Thème ─────────────
function applyTheme() {
  let t = null;
  try { t = localStorage.getItem('suricate-theme'); } catch { /* stockage indisponible */ }
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const color = isDark() ? '#0a0d13' : '#4f46e5';
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', color);
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  try { localStorage.setItem('suricate-theme', dark ? 'light' : 'dark'); } catch { /* ignoré */ }
  applyTheme();
  mountShell();
  route();
}
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);

// ───────────── Shell ─────────────
// Nom de marque en deux couleurs (« Suricate » / « Web »), le même dans la barre latérale et sur l'écran de connexion.
const brandName = () => [h('span', { class: 'suricate' }, 'Suricate'), h('span', { class: 'web' }, 'Web')];

function mountShell() {
  const tgOk = S.settings?.telegram.tokenSet && S.settings?.telegram.chatId;
  const app = S.settings?.app ?? {}; // version et liens (absents tant que les réglages ne sont pas chargés)
  const nav = (href, icon, label, id) => h('a', { href, 'data-nav': id }, ic(icon), h('span', {}, label), id === 'alertes' ? h('span', { class: 'badge', id: 'nav-badge', hidden: true }) : null);
  $('#app').replaceChildren(
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' }, h('div', { class: 'logo' }, h('img', { src: '/icon-192.png', alt: '', width: 34, height: 34 })),
          h('div', {}, h('div', { class: 'brand-name' }, h('span', {}, ...brandName()), app.version ? h('span', { class: 'ver', title: `Version ${app.version}` }, `v${app.version}`) : null), h('small', {}, 'Surveillance de sites'))),
        h('nav', { class: 'nav' }, nav('#/', 'dashboard', 'Sites', 'sites'), nav('#/alertes', 'bell', 'Alertes', 'alertes'), nav('#/reglages', 'settings', 'Réglages', 'reglages')),
        h('div', { class: 'side-foot' },
          // Forfait et jauge : calés juste au-dessus de l'indicateur Telegram, en bas de la barre latérale.
          h('div', { id: 'plan-box', class: 'plan-box', hidden: true }),
          h('a', { class: 'tg-state', href: '#/reglages' }, h('span', { class: `dot ${tgOk ? 'ok' : ''}` }), tgOk ? 'Telegram actif' : 'Telegram non configuré'),
          h('div', { class: 'side-actions' },
            // Liens externes : nouvel onglet, sans transmettre l'adresse de cette page (noopener, noreferrer)
            app.repoUrl ? h('a', { class: 'btn ghost icon sm ext', href: app.repoUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Dépôt GitHub', 'aria-label': 'Dépôt GitHub (nouvel onglet)' }, ic('github')) : null,
            app.docsUrl ? h('a', { class: 'btn ghost icon sm ext', href: app.docsUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Documentation (README)', 'aria-label': 'Documentation (nouvel onglet)' }, ic('book')) : null,
            h('button', { class: 'btn ghost icon sm', title: 'Changer de thème', 'aria-label': 'Changer de thème', onclick: toggleTheme }, ic(isDark() ? 'sun' : 'moon')),
            S.auth?.required ? h('button', { class: 'btn ghost icon sm', title: 'Se déconnecter', 'aria-label': 'Se déconnecter', onclick: guard(async () => { await api('/logout', { method: 'POST' }); S.auth.authenticated = false; boot(); }) }, ic('logout')) : null))),
      h('main', { class: 'main', id: 'view' })));
  updateNav();
  paintPlanBox();
  refreshPlan();
}

// ───── Forfait (version hébergée) : liens de compte et jauge d'usage ─────
// Tout vient des capacités annoncées par le serveur (GET /api/capabilities) : `accountLinks` et `usageUrl`. Le cœur auto-hébergé n'en
// annonce aucune, et rien n'est affiché. Les liens sont des chemins du même site (localHref) et tout passe par textContent.
const planLinks = () => (S.caps?.accountLinks ?? []).map((l) => [localHref(l?.href), String(l?.label ?? '').slice(0, 40)]).filter(([href, label]) => href && label);
let planAt = 0;
async function refreshPlan() {
  const url = localHref(S.caps?.usageUrl);
  if (!url || Date.now() - planAt < 4000) return; // la jauge change à la création ou à la suppression d'un site : pas plus d'une requête toutes les 4 s
  planAt = Date.now();
  try {
    const r = await fetch(url);
    if (r.ok) S.plan = await r.json();
  } catch { /* la jauge est un confort : jamais une erreur */ }
  paintPlanBox();
}
function paintPlanBox() {
  const box = $('#plan-box');
  if (!box) return;
  const links = planLinks();
  const name = S.plan?.plan?.name;
  const s = S.plan?.usage?.sites;
  if (!name && !links.length) { box.hidden = true; return; }
  const kids = [];
  if (name) kids.push(h('div', { class: 'plan-head' }, 'Forfait ', h('b', {}, String(name))));
  if (s && Number.isFinite(s.active)) {
    const max = Number.isFinite(s.max) ? s.max : null; // null : illimité
    kids.push(
      max ? h('div', { class: `gauge ${s.active >= max ? 'full' : ''}`, role: 'progressbar', 'aria-label': 'Sites surveillés', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': s.active }, h('i', { style: { width: `${Math.min(100, Math.round((100 * s.active) / max))}%` } })) : null,
      h('div', { class: 'plan-use muted' }, `${s.active}${max ? ` / ${max}` : ''} site${(max ?? s.active) > 1 ? 's' : ''} surveillé${(max ?? s.active) > 1 ? 's' : ''}${max ? '' : ' · illimité'}`),
    );
  }
  for (const [href, label] of links) kids.push(h('a', { href }, label));
  box.replaceChildren(...kids);
  box.hidden = false;
}

function updateNav() {
  const path = location.hash.replace(/^#\/?/, '');
  const cur = path.startsWith('alertes') ? 'alertes' : path.startsWith('reglages') ? 'reglages' : 'sites';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === cur));
  const n = S.watches.reduce((s, w) => s + (w.unread?.critical || 0) + (w.unread?.warning || 0), 0);
  const b = $('#nav-badge');
  if (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }
}

// ───────────── Routeur ─────────────
let renderToken = 0;
async function route() {
  if (!S.auth?.authenticated) return;
  const tok = ++renderToken;
  const [, a, b, c] = location.hash.match(/^#\/?([^/]*)\/?([^/]*)\/?([^/]*)/) || [];
  updateNav();
  const view = $('#view');
  if (!view) return;
  try {
    let node;
    if (a === 'sites' && b) node = await viewDetail(Number(b), c || 'apercu', tok, Number(location.hash.split('/')[4]) || null);
    else if (a === 'alertes') node = await viewAlerts();
    else if (a === 'reglages') node = await viewSettings();
    else node = await viewDashboard();
    if (tok !== renderToken) return;
    const y = window.scrollY;
    view.replaceChildren(node);
    linkLabels(view);
    window.scrollTo(0, y);
    updateNav();
  } catch (e) {
    if (tok === renderToken) view.replaceChildren(h('div', { class: 'card empty' }, h('div', { class: 'art' }, ic('alert')), h('h2', {}, 'Impossible de charger cette page'), h('p', {}, e.message), h('a', { class: 'btn', href: '#/' }, 'Retour au tableau de bord')));
  }
}
addEventListener('hashchange', () => { S.open.clear(); route(); window.scrollTo(0, 0); refreshPlan(); });

// ───────────── Temps réel ─────────────
let refreshTimer;
function busy() {
  const ae = document.activeElement;
  // Pendant un glisser-déposer, un rafraîchissement automatique détruirait la liste sous le curseur.
  return S.dragging || !!$('.drawer') || !!$('.modal') || (ae &&['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) && $('#view')?.contains(ae));
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const p = location.hash;
    if (busy() || p.startsWith('#/reglages')) return;
    route();
  }, 500);
}
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (['check', 'ack', 'idle', 'shot', 'layout'].includes(ev.type)) scheduleRefresh();
  };
}
setInterval(() => { if (document.visibilityState === 'visible' && !busy() && !location.hash.startsWith('#/reglages')) route(); }, 60000);

// ───────────── Petits composants ─────────────
function spark(values, { w = 120, h: hh = 30 } = {}) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return h('div', { class: 'spark-empty' }, 'En attente de mesures');
  const max = Math.max(...nums) * 1.1 || 1;
  const n = values.length;
  const pts = values.map((v, i) => (v == null ? null : [(i / (n - 1)) * w, hh - 3 - (v / max) * (hh - 6)]));
  let d = '';
  let pen = false;
  for (const p of pts) {
    if (!p) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  const fails = pts.map((p, i) => (p ? '' : `<rect x="${((i / (n - 1)) * w - 1).toFixed(1)}" y="0" width="2.5" height="${hh}" fill="var(--crit)" opacity=".7"/>`)).join('');
  const t = document.createElement('template');
  t.innerHTML = `<svg class="spark" viewBox="0 0 ${w} ${hh}" role="img" aria-label="Temps de réponse récents">${fails}<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return t.content.firstChild;
}

function empty(icon, title, text, ...actions) {
  return h('div', { class: 'card empty' }, h('div', { class: 'art' }, ic(icon)), h('h2', {}, title), text ? h('p', {}, text) : null, ...actions);
}

// ───────────── Tableau de bord ─────────────
async function viewDashboard() {
  const [list, settings, groups] = await Promise.all([api('/watches'), S.settings ? Promise.resolve(S.settings) : api('/settings'), api('/groups')]);
  S.watches = list;
  S.groups = groups;
  S.settings = settings;
  const active = list.filter((w) => w.enabled);
  const bad = active.filter((w) => ['critical', 'down'].includes(w.status));
  const warn = active.filter((w) => w.status === 'warning');
  const unread = list.reduce((s, w) => s + w.unread.critical + w.unread.warning, 0);
  const ups = active.map((w) => w.uptime).filter((x) => x != null);
  const avgUp = ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : null;
  const mss = active.map((w) => w.avgMs).filter((x) => x != null);
  const avgMs = mss.length ? mss.reduce((a, b) => a + b, 0) / mss.length : null;
  const last = Math.max(0, ...list.map((w) => w.lastCheck || 0));
  const tgOk = settings.telegram.tokenSet && settings.telegram.chatId;

  const root = h('div', {});
  root.append(h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, 'Mes sites'), h('p', {}, 'Contrôle permanent de l\'intégrité de vos sites, sans avoir à les ouvrir.')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: guard(async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.firstChild.classList.add('spin');
        await route();
      }) }, ic('refresh'), 'Rafraîchir'),
      h('button', { class: 'btn primary', onclick: () => openSiteForm() }, ic('plus'), 'Ajouter un site'))));

  if (!list.length) {
    const input = h('input', { class: 'input', placeholder: 'https://www.monsite.fr', 'aria-label': 'Adresse du site', onkeydown: (e) => e.key === 'Enter' && go.click() });
    const go = h('button', { class: 'btn primary', onclick: () => openSiteForm(null, input.value) }, ic('plus'), 'Surveiller');
    root.append(empty('shield', 'Aucun site surveillé pour le moment',
      "Ajoutez votre premier site : SuricateWeb détecte les défigurations, les scripts injectés, les redirections suspectes, les changements de DNS ou de certificat, et vous prévient sur Telegram.",
      h('div', { class: 'quick-add' }, input, go)));
    return root;
  }

  const state = bad.length ? 'crit' : warn.length ? 'warn' : 'ok';
  const problems = [...bad, ...warn];
  const siteTag = (w) => h('a', {
    class: `chip ${w.status === 'warning' ? 'warn' : 'crit'}`,
    href: `#/sites/${w.id}`,
    title: `Ouvrir le détail de ${w.name}`,
  }, w.name);
  root.append(h('div', { class: `health ${state}` },
    h('div', { class: 'big' }, ic(state === 'ok' ? 'checkCircle' : 'alert')),
    h('div', { class: 'health-body' },
      h('h2', {}, state === 'crit' ? `${plural(bad.length, 'site demande', 'sites demandent')} une action immédiate` : state === 'warn' ? `${plural(warn.length, 'site à vérifier', 'sites à vérifier')}` : 'Tous vos sites sont intacts'),
      h('p', {}, state === 'ok'
        ? `${plural(active.length, 'site surveillé', 'sites surveillés')} · aucune anomalie détectée · dernier contrôle ${rel(last)}`
        : `Dernier contrôle ${rel(last)}`),
      problems.length ? h('div', { class: 'health-tags' }, ...problems.map(siteTag)) : null)));

  if (!tgOk) {
    root.append(h('div', { class: 'callout' }, ic('send'),
      h('div', {}, h('b', {}, 'Recevez les alertes sur votre téléphone. '), 'Connectez un bot Telegram pour être prévenu dès qu\'un site est modifié, piraté ou tombe.'),
      h('a', { class: 'btn sm primary', href: '#/reglages' }, 'Configurer Telegram')));
  }

  root.append(h('div', { class: 'stats' },
    stat('Sites surveillés', active.length, list.length > active.length ? ` / ${list.length}` : '', 'eye'),
    stat('Disponibilité 24 h', avgUp == null ? '—' : avgUp.toFixed(avgUp === 100 ? 0 : 1).replace('.', ','), avgUp == null ? '' : ' %', 'activity'),
    stat('Alertes non lues', unread, '', 'bell'),
    stat('Temps de réponse', avgMs == null ? '—' : Math.round(avgMs), avgMs == null ? '' : ' ms', 'clock')));

  const tags = [...new Set(list.flatMap((w) => w.tags))].sort();
  const listBox = h('div', { class: 'sections' });
  const hintBox = h('p', { class: 'dnd-hint muted' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const byId = new Map(list.map((w) => [w.id, w]));
  const matches = (w) => {
    const q = S.q.trim().toLowerCase();
    if (q && !(w.name + ' ' + w.url + ' ' + w.tags.join(' ')).toLowerCase().includes(q)) return false;
    if (S.tag && !w.tags.includes(S.tag)) return false;
    if (S.filter === 'issues') return ['critical', 'down', 'warning'].includes(w.status);
    if (S.filter === 'ok') return w.status === 'ok';
    if (S.filter === 'paused') return !w.enabled;
    return true;
  };
  const noMatch = () => h('div', { class: 'card empty' }, h('p', {}, 'Aucun site ne correspond à ces filtres.'));
  const renderList = () => {
    // Réorganiser une liste filtrée est ambigu (des sites sont cachés) : le glisser-déposer n'est actif que sans filtre.
    const filtering = !!(S.q.trim() || S.tag || S.filter !== 'all');
    const canDnd = S.view === 'groups' && !filtering;
    listBox.className = `sections${canDnd ? ' dnd' : ''}`;
    hintBox.textContent = canDnd
      ? (S.groups.length ? 'Glissez ⠿ pour réorganiser vos sites et vos groupes — ou ↑ ↓ au clavier sur la poignée.' : 'Créez un groupe pour organiser vos sites, puis glissez ⠿ pour les réordonner.')
      : S.view === 'status' ? 'Vue triée par état : les sites en alerte remontent en premier.' : 'Réorganisation désactivée pendant une recherche ou un filtre.';

    if (S.view === 'status') {
      const rows = list.filter(matches).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
      listBox.replaceChildren(rows.length ? h('div', { class: 'card sites' }, ...rows.map((w) => siteRow(w, { chip: true }))) : noMatch());
      return;
    }
    const sections = [];
    for (const sec of buildModel(list, S.groups)) {
      const group = S.groups.find((g) => g.id === sec.gid) || null;
      const all = sec.ids.map((id) => byId.get(id)).filter(Boolean);
      const shown = all.filter(matches);
      if (filtering && !shown.length) continue; // pas de groupe vide pendant un filtre
      if (!group && !shown.length && !(canDnd && S.groups.length)) continue; // « Sans groupe » vide : zone de dépôt seulement en mode glisser-déposer
      sections.push(groupSection({ group, all, shown }, { canDnd, filtering }));
    }
    listBox.replaceChildren(...(sections.length ? sections : [noMatch()]));
  };
  S.redraw = renderList;

  // Un déplacement est appliqué tout de suite à l'écran, puis envoyé au serveur ; les envois sont mis en file
  // (ordre garanti) et, en cas d'échec, on recharge l'état réel plutôt que de laisser un affichage faux.
  let chain = Promise.resolve();
  const commit = (model, focus) => {
    applyModel(list, S.groups, model);
    renderList();
    if (focus) listBox.querySelector(`.handle[data-kind="${focus.kind}"][data-id="${focus.id}"]`)?.focus();
    chain = chain.then(() => api('/layout', { method: 'PUT', body: toPayload(model) })).catch((e) => { toast(e.message, 'err'); route(); });
  };
  const labels = { site: (id) => byId.get(id)?.name ?? '', group: (id) => S.groups.find((g) => g.id === id)?.name ?? '' };
  wireLayout(listBox, {
    model: () => buildModel(list, S.groups),
    commit,
    announce: (model, kind, id) => { live.textContent = describeMove(model, kind, id, labels); },
  });
  const seg = h('div', { class: 'seg', role: 'group' }, ...[['all', 'Tous'], ['issues', 'À vérifier'], ['ok', 'Intacts'], ['paused', 'En pause']].map(([k, l]) =>
    h('button', { class: S.filter === k ? 'on' : '', onclick: (e) => { S.filter = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); renderList(); } }, l)));
  root.append(h('div', { class: 'toolbar' },
    h('div', { class: 'search' }, ic('search'), h('input', { class: 'input', type: 'search', placeholder: 'Rechercher un site…', 'aria-label': 'Rechercher', value: S.q, oninput: (e) => { S.q = e.target.value; renderList(); } })),
    seg,
    tags.length ? h('div', { class: 'tags' }, ...tags.map((t) => h('button', { class: `chip btn-like ${S.tag === t ? 'on' : ''}`, onclick: (e) => { S.tag = S.tag === t ? null : t; e.currentTarget.parentNode.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.textContent === S.tag)); renderList(); } }, t))) : null));
  const viewSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Affichage de la liste' }, ...[['groups', 'Groupes'], ['status', 'Par état']].map(([k, l]) =>
    h('button', { class: S.view === k ? 'on' : '', onclick: (e) => {
      S.view = k;
      try { localStorage.setItem('suricate-view', k); } catch { /* stockage indisponible : la vue ne sera pas mémorisée */ }
      viewSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      renderList();
    } }, l)));
  root.append(h('div', { class: 'toolbar sub' }, viewSeg,
    h('button', { class: 'btn sm', onclick: guard(async () => {
      const r = await groupDialog();
      if (!r) return;
      const g = await api('/groups', { method: 'POST', body: r });
      S.groups.push(g);
      renderList();
      toast(`Groupe « ${g.name} » créé`);
    }) }, ic('folder'), 'Nouveau groupe'),
    hintBox, live));
  renderList();
  root.append(listBox);
  return root;
}

const rank = (w) => ({ down: 5, critical: 4, warning: 3, pending: 2, ok: 1, paused: 0 })[w.status];

// ───────────── Groupes de sites : affichage, glisser-déposer, clavier ─────────────

/** Palette des groupes (identique à celle du serveur, qui refuse toute autre valeur non hexadécimale). */
const GROUP_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

/**
 * Poignée de déplacement. Un <span role="button"> et non un <button> : Firefox ne sait pas faire glisser un <button>.
 * Au clavier : flèches haut / bas déplacent d'un cran (voir wireLayout).
 */
const handleBtn = (kind, id, label) => h('span', {
  // « h- » : la classe « site » est celle des lignes de la liste, et lui appliquerait leur style
  class: `handle h-${kind}`, role: 'button', tabindex: '0', draggable: 'true', 'data-kind': kind, 'data-id': id,
  'aria-label': `${label} — glisser, ou flèches haut et bas`, title: 'Glisser pour déplacer · ↑ ↓ au clavier',
  onclick: (e) => e.stopPropagation(),
}, ic('grip'));

/** Une section de la liste : un groupe (ou « Sans groupe ») avec son en-tête et ses sites. */
function groupSection({ group, all, shown }, { canDnd, filtering }) {
  const gid = group ? group.id : null;
  const hasGroups = S.groups.length > 0;
  const collapsed = !!group?.collapsed && !filtering; // un filtre déplie tout : on ne cache pas un résultat
  const active = all.filter((w) => w.enabled);
  const bad = active.filter((w) => ['critical', 'down'].includes(w.status)).length;
  const warn = active.filter((w) => w.status === 'warning').length;
  const summary = bad ? h('span', { class: 'pill crit' }, h('span', { class: 'dot' }), `${bad} en alerte`)
    : warn ? h('span', { class: 'pill warn' }, h('span', { class: 'dot' }), `${warn} à vérifier`)
      : active.length ? h('span', { class: 'pill ok' }, h('span', { class: 'dot' }), 'Intact') : null;

  const toggle = () => {
    group.collapsed = !group.collapsed;
    S.redraw();
    api(`/groups/${gid}`, { method: 'PUT', body: { collapsed: group.collapsed } }).catch((e) => toast(e.message, 'err'));
  };
  const head = hasGroups ? h('div', { class: 'grp-head' },
    canDnd && group ? handleBtn('group', gid, `Déplacer le groupe « ${group.name} »`) : null,
    group ? h('button', { class: 'btn ghost icon sm gtoggle', 'aria-expanded': String(!collapsed), 'aria-label': `${collapsed ? 'Déplier' : 'Replier'} le groupe « ${group.name} »`, onclick: toggle }, ic('chevron')) : null,
    h('span', { class: 'grp-dot', style: `--gc:${group ? group.color : 'var(--border-strong)'}` }),
    h('h3', {}, group ? group.name : 'Sans groupe'),
    h('span', { class: 'muted grp-count' }, plural(all.length, 'site', 'sites') + (filtering && shown.length !== all.length ? ` · ${shown.length} affiché(s)` : '')),
    summary,
    group ? h('div', { class: 'grp-actions' },
      all.length ? h('a', { class: 'btn ghost icon sm', href: `/api/groups/${gid}/report?tz=${tzParam()}`, target: '_blank', rel: 'noopener noreferrer', title: 'Rapport mensuel du groupe (tous ses sites)', 'aria-label': `Rapport mensuel du groupe « ${group.name} » (nouvel onglet)` }, ic('file')) : null,
      h('button', { class: 'btn ghost icon sm', title: 'Ajouter un site dans ce groupe', 'aria-label': `Ajouter un site dans « ${group.name} »`, onclick: () => openSiteForm(null, '', gid) }, ic('plus')),
      h('button', { class: 'btn ghost icon sm', title: 'Renommer, changer la couleur', 'aria-label': `Modifier le groupe « ${group.name} »`, onclick: guard(async () => {
        const r = await groupDialog(group);
        if (!r) return;
        Object.assign(group, await api(`/groups/${gid}`, { method: 'PUT', body: r }));
        S.redraw();
      }) }, ic('edit')),
      h('button', { class: 'btn ghost icon sm danger', title: 'Supprimer le groupe', 'aria-label': `Supprimer le groupe « ${group.name} »`, onclick: guard(async () => {
        const ok = await confirmDialog({
          title: `Supprimer le groupe « ${group.name} » ?`, confirm: 'Supprimer le groupe', danger: true,
          text: all.length ? `Les ${plural(all.length, 'site', 'sites')} de ce groupe ne sont pas supprimés : ils passent dans « Sans groupe ».` : 'Ce groupe est vide.',
        });
        if (!ok) return;
        await api(`/groups/${gid}`, { method: 'DELETE' });
        toast('Groupe supprimé');
        route();
      }) }, ic('trash'))) : null) : null;

  const empty = shown.length ? null : h('div', { class: 'grp-empty' }, canDnd ? (group ? 'Groupe vide — glissez un site ici.' : 'Glissez ici un site pour le sortir de son groupe.') : 'Aucun site dans ce groupe.');
  const body = h('div', { class: 'card sites', hidden: collapsed }, ...(shown.length ? shown.map((w) => siteRow(w, { handle: canDnd })) : [empty]));
  return h('section', { class: `grp${collapsed ? ' collapsed' : ''}${hasGroups ? '' : ' flat'}`, 'data-gid': gid === null ? 'none' : String(gid), style: group ? `--gc:${group.color}` : null }, head, body);
}

/**
 * Glisser-déposer natif + clavier, par délégation sur le conteneur (les écouteurs survivent aux ré-affichages).
 * ctx : { model() → modèle courant, commit(nouveauModèle, focus), announce(modèle, kind, id) }.
 * Le geste n'est qu'une traduction : le calcul du nouvel ordre est dans layout.js (testé unitairement).
 */
function wireLayout(box, ctx) {
  let drag = null; // { kind: 'site' | 'group', id }
  let drop = null; // cible courante : { kind, toGid, index } | { kind, targetGid, after } + key
  const line = h('div', { class: 'drop-line' });

  const clearMarks = () => {
    line.remove();
    box.querySelectorAll('.drop-hover').forEach((e) => e.classList.remove('drop-hover'));
    drop = null;
  };
  const end = () => {
    box.querySelectorAll('.dragging').forEach((e) => e.classList.remove('dragging'));
    clearMarks();
    drag = null;
    S.dragging = false;
  };

  box.addEventListener('dragstart', (e) => {
    const hd = e.target.closest?.('.handle');
    if (!hd) return;
    drag = { kind: hd.dataset.kind, id: Number(hd.dataset.id) };
    S.dragging = true;
    const site = drag.kind === 'site';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${drag.kind}:${drag.id}`); // Firefox refuse un glissement sans donnée
    e.dataTransfer.setDragImage(hd.closest(site ? '.site' : '.grp-head'), 18, 18);
    const marked = hd.closest(site ? '.site' : '.grp');
    requestAnimationFrame(() => marked.classList.add('dragging')); // après la capture de l'image fantôme
  });
  box.addEventListener('dragend', end);
  box.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !box.contains(e.relatedTarget)) clearMarks(); });

  box.addEventListener('dragover', (e) => {
    if (!drag) return;
    const sec = e.target.closest?.('.grp');
    if (!sec) return;
    const model = ctx.model();
    let next; // { key, desc, place }

    if (drag.kind === 'site') {
      const gid = sec.dataset.gid === 'none' ? null : Number(sec.dataset.gid);
      const ids = model.find((s) => s.gid === gid)?.ids ?? [];
      const row = e.target.closest('.site');
      const bodyEl = sec.querySelector('.sites');
      if (row) {
        const r = row.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        const index = ids.indexOf(Number(row.dataset.id)) + (before ? 0 : 1);
        next = { key: `s:${gid}:${index}`, desc: { kind: 'site', toGid: gid, index }, place: () => (before ? row.before(line) : row.after(line)) };
      } else if (!ids.length || sec.classList.contains('collapsed')) {
        // groupe vide ou replié : on met en évidence toute la zone (une ligne d'insertion n'aurait aucun sens)
        next = { key: `s:${gid}:end`, desc: { kind: 'site', toGid: gid, index: ids.length }, place: () => (sec.classList.contains('collapsed') ? sec.querySelector('.grp-head') : bodyEl).classList.add('drop-hover') };
      } else {
        next = { key: `s:${gid}:end`, desc: { kind: 'site', toGid: gid, index: ids.length }, place: () => bodyEl.append(line) };
      }
    } else {
      // Un groupe se dépose entre deux groupes ; « Sans groupe » reste toujours en dernier.
      const groups = [...box.querySelectorAll('.grp:not([data-gid="none"])')];
      let target = sec;
      let after;
      if (sec.dataset.gid === 'none') { target = groups.at(-1); after = true; } else { const r = sec.getBoundingClientRect(); after = e.clientY > r.top + r.height / 2; }
      if (!target) return;
      const targetGid = Number(target.dataset.gid);
      next = { key: `g:${targetGid}:${after}`, desc: { kind: 'group', targetGid, after }, place: () => (after ? target.after(line) : target.before(line)) };
    }

    e.preventDefault(); // autorise le dépôt
    e.dataTransfer.dropEffect = 'move';
    if (drop?.key === next.key) return; // même cible : pas de scintillement
    clearMarks();
    next.place();
    drop = { ...next.desc, key: next.key };
  });

  box.addEventListener('drop', (e) => {
    if (!drag || !drop) return;
    e.preventDefault();
    const model = ctx.model();
    const d = drag;
    const p = drop;
    end();
    const next = d.kind === 'site' ? moveSite(model, d.id, p.toGid, p.index) : moveGroup(model, d.id, p.targetGid, p.after);
    if (sameModel(next, model)) return;
    ctx.commit(next, null);
    ctx.announce(next, d.kind, d.id);
  });

  // Clavier : flèches haut / bas sur la poignée. Entrée et Espace n'ouvrent pas la page du site.
  box.addEventListener('keydown', (e) => {
    const hd = e.target.closest?.('.handle');
    if (!hd) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const kind = hd.dataset.kind;
    const id = Number(hd.dataset.id);
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    const model = ctx.model();
    const next = kind === 'site' ? stepSite(model, id, dir) : stepGroup(model, id, dir);
    if (sameModel(next, model)) return;
    ctx.commit(next, { kind, id });
    ctx.announce(next, kind, id);
  });
}

/** Dialogue de création / modification d'un groupe. Retourne { name, color } ou null si annulé. */
function groupDialog(group = null) {
  return new Promise((resolve) => {
    let color = group?.color || GROUP_COLORS[S.groups.length % GROUP_COLORS.length];
    const done = (v) => { ov.remove(); md.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const name = h('input', { class: 'input', value: group?.name || '', maxlength: '40', placeholder: 'ex. Clients, Interne, Boutiques…', autocomplete: 'off' });
    const err = h('p', { role: 'alert', style: { color: 'var(--crit)', minHeight: '18px', margin: '0 0 8px', fontSize: '13px' } });
    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Couleur du groupe' }, ...GROUP_COLORS.map((c) =>
      h('button', { type: 'button', class: 'swatch', style: `--c:${c}`, role: 'radio', 'aria-checked': String(c === color), 'aria-label': `Couleur ${c}`, onclick: (e) => {
        color = c;
        swatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === e.currentTarget)));
      } })));
    const submit = () => {
      const n = name.value.trim();
      if (!n) { err.textContent = 'Donnez un nom au groupe.'; name.focus(); return; }
      done({ name: n, color });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter' && document.activeElement === name) { e.preventDefault(); submit(); }
    };
    // « top » : au-dessus d'un tiroir déjà ouvert (création d'un groupe depuis le formulaire d'un site)
    const ov = h('div', { class: 'overlay top', onclick: () => done(null) });
    const md = h('div', { class: 'modal top', role: 'dialog', 'aria-label': group ? 'Modifier le groupe' : 'Nouveau groupe' },
      h('h2', {}, group ? 'Modifier le groupe' : 'Nouveau groupe'),
      h('div', { class: 'field' }, h('label', {}, 'Nom'), name),
      h('div', { class: 'field' }, h('label', {}, 'Couleur'), swatches),
      err,
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => done(null) }, 'Annuler'), h('button', { class: 'btn primary', onclick: submit }, group ? 'Enregistrer' : 'Créer le groupe')));
    document.body.append(ov, md);
    document.addEventListener('keydown', onKey);
    linkLabels(md);
    name.focus();
    name.select();
  });
}
const stat = (k, v, unit, icon) => h('div', { class: 'card stat' }, h('div', { class: 'k' }, ic(icon), k), h('div', { class: 'v' }, String(v), h('small', {}, unit)));

function signalChips(w) {
  const chips = [];
  const t = daysLeft(w.tlsExpires);
  if (t != null) chips.push(h('span', { class: `chip ${t < 14 ? 'crit' : t < 30 ? 'warn' : ''}`, title: `Certificat TLS valide jusqu'au ${dday(w.tlsExpires)}` }, ic('lock'), t < 0 ? 'expiré' : `${t} j`));
  const d = daysLeft(w.domainExpires);
  if (d != null) {
    // Échéance déjà lue : le délai reste indiqué, sans le traiter comme une alerte d'accueil.
    const loud = w.incidents.some((i) => i.key === 'rdap_expiring' && !i.acked);
    chips.push(h('span', { class: `chip ${loud ? (d < 7 ? 'crit' : d < 30 ? 'warn' : '') : ''}`, title: `Nom de domaine valide jusqu'au ${dday(w.domainExpires)}` }, ic('globe'), d < 0 ? 'expiré' : `${d} j`));
  }
  return chips;
}

/** opts.handle : poignée de glisser-déposer · opts.chip : affiche le groupe (vue « Par état », où les groupes ne sont pas visibles). */
function siteRow(w, opts = {}) {
  const visible = w.incidents.filter((i) => !i.acked);
  const top = visible.find((i) => i.severity === 'critical') || visible[0];
  const grp = opts.chip ? S.groups.find((g) => g.id === w.groupId) : null;
  const checkBtn = h('button', { class: 'btn ghost icon sm', title: 'Vérifier maintenant', 'aria-label': `Vérifier ${w.name} maintenant`, onclick: guard(async (e) => {
    e.stopPropagation();
    const b = e.currentTarget;
    b.disabled = true; b.firstChild.classList.add('spin');
    await api(`/watches/${w.id}/check`, { method: 'POST' });
    route();
  }) }, ic('refresh'));
  if (w.running) checkBtn.firstChild.classList.add('spin');
  // « e.target === e.currentTarget » : Entrée sur un bouton de la ligne (poignée, vérifier) ne doit pas ouvrir le site.
  return h('div', { class: `site ${w.enabled ? '' : 'dim'}`, 'data-id': w.id, tabindex: 0, role: 'link', onclick: () => (location.hash = `#/sites/${w.id}`), onkeydown: (e) => e.target === e.currentTarget && e.key === 'Enter' && (location.hash = `#/sites/${w.id}`) },
    h('div', { class: 'id' }, opts.handle ? handleBtn('site', w.id, `Déplacer « ${w.name} »`) : null, w.shot ? h('img', { class: 'thumb', src: shotUrl(w.shot, true), loading: 'lazy', alt: '', title: `Capture ${rel(w.shot.ts)}` }) : avatar(w.name), h('div', { class: 't' },
      h('div', { class: 'name' }, h('span', { class: 'n' }, w.name), statusPill(w), w.maintenanceUntil ? maintPill(w, true) : null, grp ? h('span', { class: 'gchip', style: `--gc:${grp.color}`, title: `Groupe « ${grp.name} »` }, h('span', { class: 'grp-dot' }), grp.name) : null),
      top ? h('div', { class: `issue ${top.severity === 'warning' ? 'warn' : ''}` }, top.title) : h('div', { class: 'url' }, host(w.url) + (w.tags.length ? '  ·  ' + w.tags.join(', ') : '')))),
    h('div', { class: 'sigs' }, ...signalChips(w)),
    h('div', { class: 'spark-col' }, w.mode === 'domain' ? h('div', { class: 'spark-empty' }, 'DNS + registre') : spark(w.spark)),
    w.mode === 'domain'
      ? h('div', { class: 'metric col-metric' }, h('b', {}, 'Domaine seul'), h('span', {}, 'sans site web'))
      : h('div', { class: 'metric col-metric', title: `Disponibilité sur 30 jours${w.avgMs ? ` · réponse moyenne ${fmtMs(w.avgMs)}` : ''}` }, h('b', {}, pct(w.uptime30)), h('span', {}, '30 derniers jours')),
    h('div', { class: 'metric col-when' }, h('b', {}, w.lastCheck ? rel(w.lastCheck) : 'jamais'), h('span', {}, w.enabled ? `toutes les ${w.interval < 60 ? w.interval + ' min' : w.interval / 60 + ' h'}` : 'en pause')),
    checkBtn);
}

/**
 * Barre d'onglets défilable. Sur un écran étroit, tous les onglets ne tiennent pas : le défilement existe mais n'est pas
 * visible. On l'annonce par un dégradé et une flèche cliquable du côté où il reste des onglets, et on amène l'onglet actif
 * à l'écran (il pouvait se trouver hors de la zone visible).
 */
function tabStrip(...tabs) {
  const strip = h('div', { class: 'tabs', role: 'tablist' }, ...tabs);
  const go = (dir) => strip.scrollBy({ left: dir * Math.max(120, strip.clientWidth * 0.6), behavior: 'smooth' });
  const arrow = (side, label) => h('button', { class: `tabs-nav ${side}`, type: 'button', tabindex: -1, 'aria-label': label, onclick: () => go(side === 'l' ? -1 : 1) }, ic(side === 'l' ? 'back' : 'right'));
  const wrap = h('div', { class: 'tabs-wrap' }, strip, arrow('l', 'Onglets précédents'), arrow('r', 'Onglets suivants'));
  const update = () => {
    const max = strip.scrollWidth - strip.clientWidth;
    wrap.classList.toggle('more-l', strip.scrollLeft > 4);
    wrap.classList.toggle('more-r', strip.scrollLeft < max - 4);
  };
  strip.addEventListener('scroll', update, { passive: true });
  // Après insertion dans la page seulement : les largeurs ne sont connues qu'à ce moment.
  requestAnimationFrame(() => {
    const on = strip.querySelector('a.on');
    if (on) strip.scrollLeft = Math.max(0, on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2);
    update();
  });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  ro?.observe(strip);
  return wrap;
}

// ───────────── Détail d'un site ─────────────
async function viewDetail(id, tab, tok, openSnap) {
  // Les groupes alimentent le champ « Groupe » du formulaire de modification, même si on arrive directement sur cette page.
  const [w, groups] = await Promise.all([api(`/watches/${id}`), api('/groups')]);
  S.groups = groups;
  S.cur = w;
  const root = h('div', {});
  const unread = w.unread.critical + w.unread.warning + w.unread.info;
  // L'échéance déjà lue ne compte plus dans « non lues », mais elle laisse le site « À vérifier » tant qu'elle n'est pas acquittée.
  const domainOpen = w.incidents.some((i) => (i.key === 'rdap_expiring' || /^(cms_|php_eol)/.test(i.key)) && !i.acked);

  const doCheck = guard(async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.firstChild.classList.add('spin');
    const r = await api(`/watches/${id}/check`, { method: 'POST' });
    toast(r.result?.error ? `Contrôle échoué : ${r.result.error}` : `Contrôle terminé${r.result?.code != null ? ` — HTTP ${r.result.code} en ${fmtMs(r.result.ms)}` : ''}${r.result?.alerts ? ` · ${plural(r.result.alerts, 'alerte', 'alertes')}` : ''}`, r.result?.error ? 'err' : 'ok');
    route();
  });

  root.append(
    h('a', { class: 'crumb', href: '#/' }, ic('back'), 'Tous les sites'),
    h('div', { class: 'detail-head' },
      h('div', { class: 'id' }, avatar(w.name), h('div', { class: 't' },
        h('h1', {}, w.name, statusPill(w), w.maintenanceUntil ? maintPill(w) : null),
        h('div', { class: 'url' }, h('a', { href: w.url, target: '_blank', rel: 'noopener noreferrer' }, w.url, ' ', ic('external')), w.tags.length ? '  ·  ' + w.tags.join(', ') : ''))),
      h('div', { class: 'actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        unread || domainOpen ? h('button', { class: 'btn', onclick: guard(async () => { await api(`/watches/${id}/ack`, { method: 'POST' }); toast('Marqué comme vérifié'); route(); }) }, ic('check'), 'Tout est normal') : null,
        h('button', { class: 'btn', onclick: doCheck }, ic('refresh'), 'Vérifier maintenant'),
        h('button', { class: 'btn', onclick: guard(async () => { await api(`/watches/${id}/toggle`, { method: 'POST' }); toast(w.enabled ? 'Surveillance mise en pause' : 'Surveillance reprise'); route(); }) }, ic(w.enabled ? 'pause' : 'play'), w.enabled ? 'Pause' : 'Reprendre'),
        h('button', { class: 'btn', title: 'Planifier une maintenance : alertes retenues pendant la fenêtre', onclick: guard(async () => { if (await maintenanceDialog(w)) { toast('Maintenance enregistrée'); route(); } }) }, ic('wrench'), 'Maintenance'),
        // Rapport mensuel : une page HTML à imprimer ou enregistrer en PDF (Imprimer → Enregistrer au format PDF), mois précédent par défaut.
        w.mode !== 'domain' ? h('a', { class: 'btn', href: `/api/watches/${id}/report?tz=${tzParam()}`, target: '_blank', rel: 'noopener noreferrer', title: 'Rapport mensuel client : disponibilité, incidents, mises à jour' }, ic('file'), 'Rapport') : null,
        h('button', { class: 'btn', onclick: () => openSiteForm(w) }, ic('edit'), 'Modifier'),
        h('button', { class: 'btn icon danger', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: guard(async () => {
          if (!(await confirmDialog({ title: `Supprimer « ${w.name} » ?`, text: "L'historique, les versions enregistrées et les alertes de ce site seront définitivement effacés.", confirm: 'Supprimer', danger: true }))) return;
          await api(`/watches/${id}`, { method: 'DELETE' });
          toast('Site supprimé');
          location.hash = '#/';
        }) }, ic('trash')))));

  for (const m of w.maintenance || []) {
    const active = m.start <= Date.now();
    root.append(h('div', { class: 'incident info', 'data-maintenance': m.id }, ic('wrench'),
      h('div', {}, h('b', {}, active ? `Maintenance en cours jusqu'à ${dt(m.end)}` : `Maintenance prévue du ${dt(m.start)} au ${dt(m.end)}`),
        h('p', {}, m.note ? `${m.note}. ` : '', active
          ? 'SuricateWeb continue de contrôler le site, mais retient ses alertes et ne compte aucune panne. S\'il s\'est passé quelque chose, un seul message récapitulatif est envoyé à la fin.'
          : `Durée : ${fmtDur(m.end - m.start)}. Les alertes de ce site seront retenues pendant la fenêtre.`)),
      h('button', { class: 'btn sm', style: { marginLeft: 'auto', alignSelf: 'center', flex: 'none' }, onclick: guard(async () => {
        await api(`/maintenance/${m.id}`, { method: 'DELETE' });
        toast(active ? 'Maintenance terminée : la surveillance reprend' : 'Maintenance annulée');
        route();
      }) }, active ? 'Terminer maintenant' : 'Annuler')));
  }

  for (const i of w.incidents.filter((x) => !(x.acked && /^(cms_|php_eol)/.test(x.key)))) { // l'échéance du domaine acquittée reste visible ici
    root.append(h('div', { class: `incident ${i.severity === 'warning' ? 'warn' : ''}` }, ic('alert'),
      h('div', {}, h('b', {}, i.title), i.detail ? h('p', {}, i.detail) : null, h('small', {}, `Depuis ${rel(i.since)}`))));
  }

  const domainOnly = w.mode === 'domain';
  const cmsOn = !domainOnly && (w.config?.cms?.type === 'wordpress' || w.config?.cms?.type === 'prestashop');
  const cmsN = cmsPending(w.cms);
  const cmsSecN = cmsSecurityCount(w);
  const tabs = domainOnly
    ? [['apercu', 'Aperçu', 'activity'], ['alertes', 'Alertes', 'bell'], ['domaine', 'Domaine & DNS', 'globe']]
    : [['apercu', 'Aperçu', 'activity'], ['alertes', 'Alertes', 'bell'], ['captures', 'Captures', 'image'], ['disponibilite', 'Disponibilité', 'clock'], ['modifications', 'Modifications', 'file'], ['domaine', 'Domaine & DNS', 'globe'], ...(cmsOn ? [['mises-a-jour', 'Mises à jour', 'layers'], ['securite', 'Sécurité', 'shield']] : [])];
  root.append(tabStrip(...tabs.map(([k, l, icn]) => h('a', { href: `#/sites/${id}/${k}`, class: tab === k ? 'on' : '', role: 'tab' }, ic(icn), l,
    k === 'alertes' && unread ? h('span', { class: 'badge' }, unread) : null,
    k === 'mises-a-jour' && cmsN ? h('span', { class: 'badge warn' }, cmsN) : null,
    k === 'securite' && cmsSecN ? h('span', { class: 'badge' }, cmsSecN) : null))));

  if (tab === 'modifications' && !domainOnly) root.append(await changesTab(w, openSnap));
  else if (tab === 'captures' && !domainOnly) root.append(await capturesTab(w));
  else if (tab === 'disponibilite' && !domainOnly) root.append(await uptimeTab(w));
  else if (tab === 'domaine') root.append(await domainTab(w));
  else if (tab === 'mises-a-jour' && cmsOn) root.append(updatesTab(w));
  else if (tab === 'securite' && cmsOn) root.append(securityTab(w));
  else if (tab === 'alertes') {
    const alerts = await api(`/alerts?watch=${id}&limit=100`);
    root.append(alerts.length ? alertList(alerts, false) : empty('bell', 'Aucune alerte', 'Ce site n\'a déclenché aucune alerte pour le moment.'));
  } else root.append(await overviewTab(w));
  return root;
}

/** Frise de disponibilité des 90 derniers jours, façon UptimeRobot : une barre par jour calendaire. */
function uptimeBarsCard(data, { title = 'Disponibilité', note = '' } = {}) {
  const days = data.bars;
  const known = days.filter((d) => d.uptime != null);
  const total = known.length ? known.reduce((s, d) => s + d.uptime, 0) / known.length : null;
  const cls = (u) => (u == null ? 'none' : u >= 99.9 ? '' : u >= 95 ? 'warn' : 'bad');
  return h('div', { class: 'card', style: { padding: '16px 18px', marginBottom: '16px' } },
    h('div', { class: 'ub-head' }, h('h2', {}, title), h('div', { class: 'ub-total' }, h('b', {}, pct(data.periods['90d'].uptime ?? total)), h('span', {}, ' sur 90 jours'))),
    h('div', { class: 'ub', role: 'img', 'aria-label': 'Disponibilité jour par jour sur 90 jours' }, ...days.map((d) => {
      const when = new Date(d.from).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      return h('i', { class: cls(d.uptime), title: d.uptime == null ? `${when} — pas de donnée` : `${when} — ${pct(d.uptime)}${d.outages ? ` · ${plural(d.outages, 'panne', 'pannes')} (${fmtDur(d.downtime)})` : ' · aucune panne'}` });
    })),
    h('div', { class: 'ub-foot' }, h('span', {}, 'Il y a 90 jours'), note ? h('span', {}, note) : null, h('span', {}, "Aujourd'hui")));
}

const tzParam = () => -new Date().getTimezoneOffset();

async function overviewTab(w) {
  const root = h('div', {});
  const s = w.signals;
  const c = w.config.checks;

  if (w.mode === 'domain') {
    root.append(h('div', { class: 'callout' }, ic('globe'), h('div', {}, h('b', {}, 'Surveillance du domaine seul. '), 'Aucune requête n\'est envoyée à un site web : SuricateWeb suit les enregistrements DNS et la fiche du domaine au registre (transfert, registrar, serveurs de noms, verrou, DNSSEC, expiration).'),
      h('a', { class: 'btn sm', href: `#/sites/${w.id}/domaine` }, 'Voir le détail')));
    root.append(h('div', { class: 'signals' }, dnsSignal(s, c), domainSignal(s, c)));
    return root;
  }

  const last = w.checks.at(-1);
  root.append(h('div', { class: 'ov-top' }, previewCard(w), h('div', { class: 'kpis' },
    kpi('État HTTP', last?.code ?? '—', last ? (last.ok ? 'Page accessible' : last.error || 'Erreur') : 'Pas encore contrôlé'),
    kpi('Temps de réponse', fmtMs(last?.ms), w.avgMs ? `moyenne 24 h : ${fmtMs(w.avgMs)}` : ''),
    kpi('Disponibilité 30 jours', pct(w.uptime30), `24 h : ${pct(w.uptime)}`),
    kpi('Taille de la page', fmtBytes(last?.size), `prochain contrôle ${w.enabled ? rel(w.nextRun) : '— (en pause)'}`))));

  const u = await api(`/watches/${w.id}/uptime?tz=${tzParam()}`).catch(() => null);
  if (u) root.append(uptimeBarsCard(u));

  root.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Temps de réponse'), h('span', { class: 'muted' }, `${w.checks.length} dernières mesures`)), responseChart(w.checks)));

  root.append(h('div', { class: 'section-title' }, h('h2', {}, 'Signaux surveillés')));
  const cards = [];

  cards.push(signal('file', 'Contenu', c.content ? ['ok', 'Surveillé'] : ['mute', 'Désactivé'], [
    ['Titre', w.title || '—'], ['Référence', s.baseline ? 'établie' : 'en cours…'], ['Intervalle', w.interval < 60 ? `${w.interval} min` : `${w.interval / 60} h`],
    ['Filtre CSS', w.config.selector || 'page entière'], ['Mots interdits', c.keywords ? 'liste intégrée' + (w.config.forbidden.length ? ` + ${w.config.forbidden.length}` : '') : 'désactivé'],
  ]));

  if (w.url.startsWith('https:')) {
    const t = s.tls;
    const days = t ? daysLeft(t.expires) : null;
    const pill = !c.tls ? ['mute', 'Désactivé'] : !t ? ['mute', 'En attente'] : !t.authorized ? ['crit', 'Invalide'] : days < 14 ? ['warn', `${days} j restants`] : ['ok', 'Valide'];
    cards.push(signal('lock', 'Certificat TLS', pill, t ? [['Émetteur', t.issuer || '—'], ['Domaine', t.subject || '—'], ['Expire le', `${dday(t.expires)} (${days} j)`], ['Protocole', t.protocol || '—']] : []));
  } else cards.push(signal('lock', 'Chiffrement', ['warn', 'HTTP'], [['Connexion', 'Non chiffrée (http://)']]));

  cards.push(dnsSignal(s, c), domainSignal(s, c));

  cards.push(signal('server', 'Serveur & redirections', c.redirect ? ['ok', 'Surveillé'] : ['mute', 'Désactivé'], [
    ['URL finale', w.finalUrl || '—'], ['Logiciel', s.server || '—'], ['Scripts chargés', s.scripts ?? '—'], ['Domaines externes liés', s.linkHosts ?? '—'],
  ]));
  root.append(h('div', { class: 'signals' }, ...cards));
  if (w.pages?.length) root.append(pagesCard(w));
  return root;
}

/** Pages supplémentaires (panier, contact, connexion…) : dernier état connu de chacune. */
function pagesCard(w) {
  const state = (p) => {
    const st = p.state;
    if (!p.href) return ['crit', 'Adresse invalide'];
    if (!st) return ['mute', 'En attente'];
    if (st.error) return [st.fails >= w.config.failThreshold ? 'crit' : 'warn', st.fails >= w.config.failThreshold ? 'Inaccessible' : 'Échec isolé'];
    if (st.code >= 400 && ![401, 403, 429].includes(st.code)) return ['crit', `HTTP ${st.code}`];
    return ['ok', st.baseline ? 'Surveillée' : 'Référence en cours'];
  };
  return h('div', { class: 'card', style: { marginTop: '16px' } },
    h('div', { class: 'card-head' }, h('h2', {}, 'Pages surveillées'), h('span', { class: 'muted' }, 'scripts, iframes, formulaires et textes suspects')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Page'), h('th', {}, 'État'), h('th', {}, 'Code'), h('th', {}, 'Réponse'), h('th', {}, 'Dernier contrôle'))),
      h('tbody', {}, ...w.pages.map((p) => {
        const [cls, label] = state(p);
        return h('tr', {},
          h('td', {}, p.label || p.url, h('div', { class: 'muted mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, p.href || p.url)),
          h('td', {}, h('span', { class: `pill ${cls}`, title: p.state?.error || '' }, label)),
          h('td', { class: 'mono' }, p.state?.code ?? '—'), h('td', { class: 'mono' }, fmtMs(p.state?.ms)),
          h('td', { class: 'muted' }, p.state?.checkedAt ? rel(p.state.checkedAt) : '—'));
      })))));
}

function dnsSignal(s, c) {
  const d = s.dns;
  const split = Object.values(s.resolvers || {}).some((ns) => JSON.stringify(ns) !== JSON.stringify(d?.ns));
  return signal('network', 'DNS', !c.dns ? ['mute', 'Désactivé'] : !d ? ['mute', 'En attente'] : split ? ['warn', 'Réponses divergentes'] : ['ok', 'Cohérent'],
    d ? [['IPv4', d.a?.join(', ') || '—'], ['IPv6', d.aaaa?.length ? d.aaaa.join(', ') : '—'], ['Serveurs NS', d.ns?.join(', ') || '—'], ['Messagerie MX', d.mx?.join(', ') || '—']] : []);
}

function domainSignal(s, c) {
  const r = s.rdap;
  const dd = r?.expires ? daysLeft(r.expires) : null;
  const risky = (r?.status || []).some((x) => /pending transfer|hold|redemption|pending delete/.test(x));
  const pill = !c.rdap ? ['mute', 'Désactivé'] : r?.unsupported ? ['mute', 'Non disponible'] : !r || !r.registrar && !r.expires ? ['mute', 'En attente']
    : risky ? ['crit', 'Statut sensible'] : dd != null && dd < 30 ? ['warn', `${dd} j restants`] : ['ok', 'Surveillé'];
  return signal('globe', 'Nom de domaine', pill,
    r && !r.unsupported && (r.registrar || r.expires)
      ? [['Registrar', r.registrar || '—'], ['Expire le', r.expires ? `${dday(r.expires)} (${dd} j)` : '—'], ['Verrou anti-transfert', lockLabel(r)], ['Dernier transfert', r.transferred ? dday(r.transferred) : 'aucun connu']]
      : r?.unsupported ? [['Info', "L'extension de ce domaine n'expose pas de service RDAP."]] : []);
}

const lockLabel = (r) => (r.locked ? 'Actif' : (r.status || []).some((x) => /prohibited/.test(x)) ? 'Partiel' : 'Non exposé par le registre');

const kpi = (k, v, s) => h('div', { class: 'card kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v)), h('div', { class: 's' }, s || ' '));
const signal = (icon, title, [cls, label], rows) => h('div', { class: 'card signal' }, h('h3', {}, ic(icon), title, h('span', { class: `pill ${cls}` }, label)),
  rows.length ? h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])) : h('p', { class: 'muted' }, 'Les données apparaîtront après le prochain contrôle.'));

/**
 * Courbe de temps de réponse. `checks` : points {ts, ms, ok, code?, error?}. Un point `ok: false` est marqué en rouge
 * (panne sur ce contrôle, cette heure ou ce jour). `daily` : les points sont des jours entiers.
 */
function responseChart(checks, { daily = false, agg = false } = {}) {
  const n = checks.length;
  if (n < 2) return h('div', { class: 'muted', style: { padding: '36px', textAlign: 'center' } }, 'Pas encore assez de mesures pour tracer la courbe.');
  const W = 800, H = 190, L = 50, R = 10, T = 12, B = 24;
  const label = (ts) => (daily ? new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : dt(ts));
  const vals = checks.filter((c) => c.ms != null).map((c) => c.ms);
  const raw = Math.max(100, ...vals) * 1.1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const max = [1, 2, 5, 10].map((m) => m * mag).find((m) => m >= raw);
  const x = (i) => L + (i * (W - L - R)) / (n - 1);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  let line = '', area = '', seg = [];
  const flush = () => {
    if (seg.length) {
      const pts = seg.map((p) => p.join(',')).join('L');
      line += `M${pts}`;
      area += `M${seg[0][0]},${H - B}L${pts}L${seg.at(-1)[0]},${H - B}Z`;
    }
    seg = [];
  };
  checks.forEach((c, i) => (c.ms != null ? seg.push([x(i).toFixed(1), y(c.ms).toFixed(1)]) : flush()));
  flush();
  const bw = Math.max(2, (W - L - R) / n);
  const fails = checks.map((c, i) => (c.ok ? '' : `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}" fill="var(--crit)" opacity=".28"/>`)).join('');
  const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W - R}" y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}" stroke="var(--border)" stroke-dasharray="${f ? '3 4' : '0'}"/><text x="${L - 8}" y="${(y(max * f) + 4).toFixed(1)}" text-anchor="end">${fmtMs(max * f)}</text>`).join('');
  const t = document.createElement('template');
  t.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe du temps de réponse">${grid}${fails}<path d="${area}" fill="var(--accent)" opacity=".12"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><line id="cx" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/><text x="${L}" y="${H - 6}">${label(checks[0].ts)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${label(checks.at(-1).ts)}</text></svg>`;
  const svg = t.content.firstChild;
  const tip = h('div', { class: 'tip', hidden: true });
  const wrap = h('div', { class: 'chart-wrap' }, svg, tip);
  wrap.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    const c = checks[i];
    const cx = svg.querySelector('#cx');
    cx.setAttribute('x1', x(i)); cx.setAttribute('x2', x(i)); cx.setAttribute('visibility', 'visible');
    tip.hidden = false;
    const avg = c.ms != null ? `${agg ? 'moy. ' : ''}${fmtMs(c.ms)}` : '';
    tip.textContent = `${label(c.ts)} · ${c.ok ? `${avg}${c.code ? ` · HTTP ${c.code}` : ''}` : `${c.error || 'indisponibilité'}${avg ? ` · ${avg}` : ''}`}`;
    tip.style.left = `${(x(i) / W) * r.width + 16}px`;
    tip.style.top = `${(c.ms != null ? y(c.ms) : T + 30) * (r.height / H) + 14}px`;
  });
  wrap.addEventListener('mouseleave', () => { tip.hidden = true; svg.querySelector('#cx').setAttribute('visibility', 'hidden'); });
  return wrap;
}

// ───────────── Captures d'écran ─────────────
const SHOT_KIND = { scheduled: ['Planifiée', ''], manual: ['Manuelle', 'info'], alert: ['Alerte', 'crit'] };
// L'image est mise en cache un an : la date de capture fait partie de l'adresse, pour qu'un numéro de capture réutilisé
// (base recréée, volume réinitialisé) ne ressorte jamais l'image d'un autre site depuis le cache du navigateur.
const shotUrl = (s, thumb) => `/api/screenshots/${s.id}/image?v=${s.ts}${thumb ? '&thumb=1' : ''}`;
/** Adresse capturée : un nom de domaine différent de celui du site (redirection, page d'hébergeur) est signalé. */
const shotOffSite = (it, w) => { try { return !!it.finalUrl && host(it.finalUrl) !== host(w.url) && !host(it.finalUrl).endsWith(`.${host(w.url)}`) && !host(w.url).endsWith(`.${host(it.finalUrl)}`); } catch { return false; } };
/** Limites proposées pour le nombre de captures conservées ; une valeur personnalisée déjà enregistrée est ajoutée à la liste. */
const KEEP_CHOICES = [12, 24, 72, 168, 336, 720, 1000];
const keepOptions = (current) => [...new Set([...KEEP_CHOICES, current].filter(Boolean))].sort((a, b) => a - b);
/** « 7 jours » pour 10 080 minutes : la durée d'historique que couvrent N captures à une fréquence donnée. */
const spanLabel = (min) => (min < 120 ? `${Math.round(min)} min` : min < 2880 ? `${Math.round(min / 60)} heures` : `${Math.round(min / 1440)} jours`);
const everyLabel = (min) => (min < 60 ? `${min} min` : min < 1440 ? `${min / 60} h` : `${min / 1440} j`);

function captureNowButton(w) {
  const btn = h('button', { class: 'btn sm', onclick: async () => {
    btn.disabled = true;
    btn.firstChild.classList.add('spin');
    try {
      await api(`/watches/${w.id}/screenshot`, { method: 'POST' });
      toast('Capture enregistrée');
    } catch (e) {
      toast(e.message, 'err');
    } finally { route(); }
  } }, ic('camera'), 'Capturer maintenant');
  return btn;
}

/** Aperçu du site, dans un cadre de navigateur : la dernière capture, en grand, dès l'ouverture de la page. */
function previewCard(w) {
  const avail = S.settings?.screenshots?.available;
  const planOff = S.settings?.screenshots?.allowed === false; // le forfait n'inclut pas les captures
  const on = w.config.screenshot.enabled;
  const s = w.shot;
  const body = s
    ? h('button', { class: 'pv-img', title: 'Agrandir', 'aria-label': 'Agrandir la capture', onclick: guard(async () => {
      const d = await api(`/watches/${w.id}/screenshots`);
      openLightbox(d.items, Math.max(0, d.items.findIndex((x) => x.id === s.id)), w);
    }) }, h('img', { src: shotUrl(s), alt: `Capture de ${w.name}` }))
    : h('div', { class: 'pv-empty' }, ic('image'),
      h('b', {}, planOff ? 'Non incluses dans votre forfait' : !avail ? 'Navigateur introuvable' : !on ? 'Captures désactivées' : w.shotError ? 'Capture impossible' : 'Première capture en cours…'),
      h('span', {}, planOff ? 'Passez à un forfait supérieur pour suivre l\'apparence de vos sites.' : !avail ? 'Installez Chrome ou Chromium sur le serveur, ou définissez CHROME_PATH.' : !on ? 'Activez-les dans « Modifier › Capture d\'écran ».' : w.shotError || 'Elle apparaît dans quelques secondes.'));
  return h('div', { class: 'card pv' },
    h('div', { class: 'pv-bar' }, h('span', { class: 'pv-dots' }, h('i'), h('i'), h('i')), h('span', { class: 'pv-url' }, host(w.url)),
      s ? h('span', { class: 'pv-when', title: new Date(s.ts).toLocaleString('fr-FR') }, rel(s.ts)) : null),
    body,
    h('div', { class: 'pv-foot' },
      avail && on ? captureNowButton(w) : null,
      s && w.shotError ? h('span', { class: 'chip crit', title: w.shotError }, ic('alert'), 'Dernière tentative en échec') : null,
      h('a', { class: 'btn sm ghost', style: { marginLeft: 'auto' }, href: `#/sites/${w.id}/captures` }, 'Historique', ic('right'))));
}

async function capturesTab(w) {
  const d = await api(`/watches/${w.id}/screenshots`);
  const root = h('div', {});
  if (d.allowed === false) root.append(h('div', { class: 'callout' }, ic('info'), h('div', {}, h('b', {}, 'Les captures d\'écran ne sont pas incluses dans votre forfait. '), 'Passez à un forfait supérieur pour les activer.')));
  if (!d.available) {
    root.append(h('div', { class: 'callout' }, ic('info'), h('div', {}, h('b', {}, 'Aucun navigateur sur le serveur. '), 'Les captures d\'écran nécessitent Chrome ou Chromium. Installez-le, ou indiquez son chemin dans la variable CHROME_PATH (déjà inclus dans l\'image Docker).')));
  } else {
    root.append(h('div', { class: 'card', style: { padding: '14px 18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' } },
      h('div', { style: { flex: 1, minWidth: '220px' } },
        h('b', {}, d.enabled ? `Une capture toutes les ${everyLabel(d.interval)}` : 'Captures désactivées pour ce site'),
        h('div', { class: 'muted', style: { fontSize: '13px' } }, d.enabled ? (d.capturing ? 'Capture en cours…' : `Prochaine ${rel(d.nextShot)} · ${w.config.screenshot.width}×${w.config.screenshot.height}${w.config.screenshot.fullPage ? ', page entière' : ''}`) : 'Activez-les dans « Modifier › Capture d\'écran ».',
        h('div', { class: 'muted', style: { fontSize: '13px' }, title: 'Les captures manuelles et d\'alerte ont leur propre quota : elles ne sont jamais écrasées par les planifiées.' },
          `Conservation : ${d.keep} captures planifiées par site (et jusqu'à ${d.keepOther} manuelles ou d'alerte) · en stock : ${d.count} · ${fmtBytes(d.bytes)}`))),
      d.enabled ? captureNowButton(w) : h('button', { class: 'btn sm', onclick: () => openSiteForm(w) }, ic('edit'), 'Modifier')));
  }
  if (d.error) root.append(h('div', { class: 'incident warn' }, ic('alert'), h('div', {}, h('b', {}, 'Dernière capture en échec'), h('p', {}, d.error))));
  if (!d.items.length) {
    root.append(empty('image', 'Aucune capture pour le moment', d.available && d.enabled ? 'La première apparaît dans quelques secondes.' : ''));
    return root;
  }
  root.append(h('div', { class: 'shots' }, ...d.items.map((it, i) => {
    const [label, cls] = SHOT_KIND[it.kind] || SHOT_KIND.scheduled;
    return h('button', { class: 'shot', onclick: () => openLightbox(d.items, i, w), 'aria-label': `Capture du ${dt(it.ts)}` },
      h('img', { src: shotUrl(it, true), loading: 'lazy', alt: '' }),
      h('div', { class: 'shot-meta', title: it.finalUrl ? `${it.finalUrl}${it.title ? ` — ${it.title}` : ''}` : '' }, h('b', {}, dt(it.ts)), shotOffSite(it, w) ? h('span', { class: 'pill warn' }, 'Autre domaine') : null, cls ? h('span', { class: `pill ${cls}` }, label) : h('span', { class: 'muted' }, rel(it.ts))));
  })));
  return root;
}

/** Visionneuse : navigation ←/→ entre les captures, et comparaison côte à côte « avant / après ». */
function openLightbox(items, start, w) {
  if (!items.length) return;
  let i = start;
  let compare = false;
  const stage = h('div', { class: 'lb-stage' });
  const title = h('div', { class: 'lb-title' });
  const older = h('button', { class: 'btn sm', onclick: () => go(i + 1), title: 'Capture plus ancienne (←)' }, ic('back'), 'Plus ancienne');
  const newer = h('button', { class: 'btn sm', onclick: () => go(i - 1), title: 'Capture plus récente (→)' }, 'Plus récente', ic('right'));
  const cmp = h('button', { class: 'btn sm', onclick: () => { compare = !compare; render(); }, title: 'Comparer avec la capture précédente' }, ic('columns'), 'Comparer');
  const fig = (label, it) => h('figure', {}, label ? h('figcaption', {}, h('b', {}, label), ` · ${dt(it.ts)}`) : null, h('img', { src: shotUrl(it), alt: `Capture du ${dt(it.ts)}` }));
  const go = (n) => { if (n >= 0 && n < items.length) { i = n; render(); } };
  function render() {
    const cur = items[i];
    const prev = items[i + 1];
    const [label, cls] = SHOT_KIND[cur.kind] || SHOT_KIND.scheduled;
    title.replaceChildren(h('b', {}, w.name), h('span', {}, `${dt(cur.ts)} · ${rel(cur.ts)}`),
      cur.finalUrl ? h('span', { class: 'muted', title: cur.finalUrl }, `${host(cur.finalUrl)}${cur.title ? ` — « ${cur.title} »` : ''}`) : null, shotOffSite(cur, w) ? h('span', { class: 'pill warn' }, 'Autre domaine que le site') : null, cls ? h('span', { class: `pill ${cls}` }, label) : null, h('span', { class: 'muted' }, `${i + 1} / ${items.length}`));
    const two = compare && prev;
    stage.className = `lb-stage${two ? ' two' : ''}`;
    stage.replaceChildren(...(two ? [fig('Avant', prev), fig('Après', cur)] : [fig(null, cur)]));
    stage.scrollTop = 0;
    older.disabled = i >= items.length - 1;
    newer.disabled = i <= 0;
    cmp.disabled = !prev;
    cmp.classList.toggle('on', !!two);
  }
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(i + 1);
    else if (e.key === 'ArrowRight') go(i - 1);
  };
  const lb = h('div', { class: 'lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Capture d\'écran', onclick: (e) => e.target === lb && close() },
    h('div', { class: 'lb-bar' }, title, h('div', { class: 'lb-actions' }, older, newer, cmp,
      h('a', { class: 'btn sm', href: shotUrl(items[start]), target: '_blank', rel: 'noopener' }, ic('external'), 'Original'),
      h('button', { class: 'btn sm icon', 'aria-label': 'Fermer', onclick: close }, ic('x')))),
    stage);
  document.body.append(lb);
  document.addEventListener('keydown', onKey);
  render();
  $('.btn.icon', lb).focus();
}

// ───────────── Disponibilité (type UptimeRobot) ─────────────
const RANGES = [['24h', '24 h'], ['7d', '7 jours'], ['30d', '30 jours'], ['90d', '90 jours']];

async function uptimeTab(w) {
  const [u, first] = await Promise.all([api(`/watches/${w.id}/uptime?tz=${tzParam()}`), api(`/watches/${w.id}/series?range=24h`)]);
  const root = h('div', {});
  const now = Date.now();
  const c = u.current;

  root.append(h('div', { class: `uhero ${c.state}` },
    h('div', { class: 'big' }, ic(c.state === 'up' ? 'checkCircle' : c.state === 'down' ? 'alert' : 'pause')),
    h('div', {},
      h('h2', {}, c.state === 'up' ? 'Opérationnel' : c.state === 'down' ? 'En panne' : 'Surveillance en pause'),
      h('p', {}, c.state === 'down' ? `Indisponible depuis ${fmtDur(now - c.since)} (${dt(c.since)})${c.reason ? ` · ${c.reason}` : ''}`
        : c.state === 'paused' ? 'Aucun contrôle n\'est effectué tant que la surveillance est en pause.'
          : u.outages.length ? `Disponible depuis ${fmtDur(now - c.since)} · dernière panne le ${dt(u.outages[0].start)}` : `Aucune panne depuis le début de la surveillance (${fmtDur(now - u.since)})`))));

  const level = (x) => (x == null ? '' : x >= 99.9 ? 'ok' : x >= 95 ? 'warn' : 'bad');
  root.append(h('div', { class: 'kpis' }, ...[['24h', 'Dernières 24 h'], ['7d', '7 jours'], ['30d', '30 jours'], ['90d', '90 jours']].map(([k, l]) => {
    const p = u.periods[k];
    return h('div', { class: 'card kpi' }, h('div', { class: 'k' }, l), h('div', { class: `v ${level(p.uptime)}` }, pct(p.uptime)),
      h('div', { class: 's' }, p.uptime == null ? 'pas assez de recul' : p.outages ? `${plural(p.outages, 'panne', 'pannes')} · ${fmtDur(p.downtime)}` : 'aucune interruption'));
  })));

  root.append(uptimeBarsCard(u, { title: 'Jour par jour' }));

  // Temps de réponse : la plage se change sans recharger la page.
  const chartBox = h('div', {});
  const statsBox = h('div', { class: 'rt-stats' });
  const draw = (range, points) => {
    chartBox.replaceChildren(responseChart(points, { daily: range === '30d' || range === '90d', agg: range !== '24h' }));
    const s = u.response[range];
    statsBox.replaceChildren(...[['Moyenne', s.avg], ['Minimum', s.min], ['Maximum', s.max]].map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, fmtMs(v)))));
  };
  const seg = h('div', { class: 'seg', role: 'group' }, ...RANGES.map(([k, l]) => h('button', { class: k === '24h' ? 'on' : '', onclick: guard(async (e) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
    draw(k, (await api(`/watches/${w.id}/series?range=${k}`)).points);
  }) }, l)));
  draw('24h', first.points);
  root.append(h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-head' }, h('h2', {}, 'Temps de réponse'), seg), statsBox, chartBox));

  const rows = u.outages;
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Historique des pannes'), h('span', { class: 'muted' }, rows.length ? plural(rows.length, 'panne', 'pannes') : '')),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ...['État', 'Début', 'Fin', 'Durée', 'Cause'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows.map((o) => h('tr', {},
        h('td', {}, h('span', { class: `pill ${o.ongoing ? 'crit' : 'ok'}` }, h('span', { class: 'dot' }), o.ongoing ? 'En cours' : 'Résolue')),
        h('td', {}, dt(o.start)), h('td', {}, o.ongoing ? '—' : dt(o.end)), h('td', {}, h('b', {}, fmtDur(o.duration))), h('td', { class: 'muted' }, o.reason || '—'))))))
      : h('div', { class: 'empty', style: { padding: '36px 24px' } }, h('p', { style: { margin: 0 } }, 'Aucune panne depuis le début de la surveillance.'))));
  return root;
}

// ───────────── Mises à jour (WordPress / PrestaShop) ─────────────

function cmsRowState(item) {
  if (item?.available) return h('span', { class: 'pill warn' }, 'Mise à jour');
  if (item?.known === false) return h('span', { class: 'pill mute' }, 'Inconnue');
  return h('span', { class: 'pill ok' }, 'À jour');
}

function cmsTable(title, items) {
  const rows = [...(items || [])].sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'fr'));
  return h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('h2', {}, title), h('span', { class: 'muted' }, rows.length ? plural(rows.filter((r) => r.available).length, 'mise à jour', 'mises à jour') : 'aucun élément')),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Nom'), h('th', {}, 'Version actuelle'), h('th', {}, 'Version disponible'), h('th', {}, 'État'))),
      h('tbody', {}, ...rows.map((r) => h('tr', {},
        h('td', {}, r.name, r.active === false ? h('span', { class: 'muted' }, ' · inactif') : null),
        h('td', { class: 'mono' }, r.current || '—'),
        h('td', { class: 'mono' }, r.available || '—', r.available && r.since ? h('span', { class: 'muted', title: 'Depuis le premier relevé de SuricateWeb qui voit cette version disponible' }, ` · ${fmtDur(Date.now() - r.since)}`) : null),
        h('td', {}, cmsRowState(r)),
      )))))
      : h('div', { class: 'empty', style: { padding: '22px' } }, h('p', { style: { margin: 0 } }, 'Rien à afficher pour le moment.')));
}

const dUtc = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
function phpPill(sup) {
  if (sup?.status === 'ended') return h('span', { class: 'pill crit', style: { marginLeft: '10px' }, title: 'Plus aucun correctif de sécurité n\'est publié pour cette branche de PHP.' }, sup.endsAt ? `PHP ${sup.branch} non maintenu depuis le ${dUtc(sup.endsAt)}` : `PHP ${sup.branch} non maintenu`);
  if (sup?.status === 'ending') return h('span', { class: 'pill warn', style: { marginLeft: '10px' } }, `Fin du support de PHP ${sup.branch} le ${dUtc(sup.endsAt)}`);
  return null;
}

function updatesTab(w) {
  const report = w.cms;
  const kind = w.config.cms.type === 'prestashop' ? 'PrestaShop' : 'WordPress';
  const extLabel = w.config.cms.type === 'prestashop' ? 'Modules' : 'Extensions';
  const refresh = h('button', { class: 'btn', onclick: guard(async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const r = await api(`/watches/${w.id}/cms`, { method: 'POST' });
    toast(r.ok ? 'Versions mises à jour' : (r.error || 'Relevé impossible'), r.ok ? 'ok' : 'err');
    route();
  }) }, ic('refresh'), 'Actualiser');
  const root = h('div', {});
  if (!report?.checkedAt || (!report.ok && !report.core)) {
    root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, kind), h('span', { class: 'muted' }, 'en attente du premier relevé')), refresh),
      h('div', { class: 'card-pad' },
        report?.error ? h('div', { class: 'callout', style: { marginBottom: '14px' } }, ic('alert'), h('div', {}, report.error)) : null,
        h('p', {}, 'Installez le plugin sur le site, collez le jeton ci-dessous dans ses réglages, puis actualisez.'),
        h('p', { class: 'mono', style: { wordBreak: 'break-all' } }, w.config.cms.token || '—'),
        h('p', {}, h('a', { class: 'btn', href: `/api/plugins/${w.config.cms.type}.zip` }, ic('download'), ` Télécharger le plugin ${kind}`)),
      )));
    return root;
  }
  root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, `${kind} ${report.cmsVersion || report.core?.current || ''}`.trim()), h('span', { class: 'muted' }, `PHP ${report.php || '—'} · relevé ${rel(report.checkedAt)}`), phpPill(report.phpSupport)),
      refresh),
    report.error ? h('div', { class: 'card-pad', style: { paddingBottom: 0 } }, h('div', { class: 'callout' }, ic('alert'), h('div', {}, report.error, h('span', { class: 'muted' }, ' Le tableau reste celui du dernier relevé réussi.')))) : null,
  ));
  root.append(cmsTable('Noyau', report.core ? [{ name: kind, current: report.core.current, available: report.core.available, known: report.core.known, since: report.core.since, active: true }] : []));
  root.append(cmsTable(extLabel, report.extensions));
  root.append(cmsTable('Thèmes', report.themes));
  if (report.history?.length) {
    const KIND = { core: 'noyau', ext: w.config.cms.type === 'prestashop' ? 'module' : 'extension', theme: 'thème' };
    root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'card-head' }, h('h2', {}, 'Mises à jour effectuées'), h('span', { class: 'muted' }, 'vues par SuricateWeb d’un relevé à l’autre')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Élément'), h('th', {}, 'Version'))),
        h('tbody', {}, ...[...report.history].reverse().slice(0, 15).map((e) => h('tr', {},
          h('td', {}, dt(e.ts)), h('td', {}, e.name, h('span', { class: 'muted' }, ` · ${KIND[e.kind] || e.kind}`)),
          h('td', { class: 'mono' }, e.from ? `${e.from} → ${e.to}` : `installé : ${e.to}`))))))));
  }
  return root;
}

// ───────────── Sécurité du CMS : intégrité des fichiers et comptes administrateurs ─────────────

const pathItems = (list, tag) => list.map((f) => h('li', {}, h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, f), h('span', { class: 'muted' }, ` · ${tag}`)));

function integritySection(title, sec, hint) {
  const bad = sec.modified.length + sec.added.length;
  const pill = !sec.known ? h('span', { class: 'pill mute' }, 'Non vérifiable')
    : bad ? h('span', { class: 'pill crit' }, plural(bad, 'anomalie', 'anomalies'))
      : sec.missing.length ? h('span', { class: 'pill warn' }, plural(sec.missing.length, 'fichier manquant', 'fichiers manquants'))
        : h('span', { class: 'pill ok' }, 'Conforme');
  return h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('h2', {}, title), h('span', { class: 'muted' }, sec.known ? `${sec.checked} fichiers comparés` : ''), pill),
    bad || sec.missing.length
      ? h('div', { class: 'card-pad' }, h('ul', { class: 'plain', style: { margin: 0, paddingLeft: '18px' } }, ...pathItems(sec.modified, 'modifié'), ...pathItems(sec.added, 'fichier PHP ajouté'), ...pathItems(sec.missing, 'manquant')),
        sec.more ? h('p', { class: 'muted' }, `… et ${sec.more} autre(s) non listé(s).`) : null)
      : hint ? h('div', { class: 'card-pad' }, h('p', { class: 'muted', style: { margin: 0 } }, hint)) : null);
}

function securityTab(w) {
  const report = w.cms;
  const shop = w.config.cms.type === 'prestashop';
  const kind = shop ? 'PrestaShop' : 'WordPress';
  const root = h('div', {});
  const refresh = h('button', { class: 'btn', onclick: guard(async (e) => {
    e.currentTarget.disabled = true;
    const r = await api(`/watches/${w.id}/cms`, { method: 'POST' });
    toast(r.ok ? 'Contrôles actualisés' : (r.error || 'Relevé impossible'), r.ok ? 'ok' : 'err');
    route();
  }) }, ic('refresh'), 'Actualiser');
  if (w.config.cms.security === false) {
    root.append(h('div', { class: 'callout' }, ic('info'), h('div', {}, 'Le contrôle de sécurité est désactivé pour ce site. Réactivez-le dans « Modifier › WordPress / PrestaShop ».')));
    return root;
  }
  const integ = report?.integrity;
  const admins = report?.admins;
  root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, `Sécurité de ${kind}`), h('span', { class: 'muted' }, integ?.checkedAt ? `intégrité contrôlée ${rel(integ.checkedAt)}` : 'en attente du premier contrôle')), refresh),
    h('div', { class: 'card-pad' },
      integ?.error ? h('div', { class: 'callout', style: { marginBottom: '12px' } }, ic('alert'), h('div', {}, integ.error, integ.core ? h('span', { class: 'muted' }, ' Les résultats ci-dessous sont ceux du dernier contrôle réussi.') : null)) : null,
      h('p', { class: 'muted', style: { margin: 0 } }, shop
        ? 'Sous PrestaShop, le module cherche des fichiers PHP là où il ne devrait pas y en avoir (img/, upload/, download/). PrestaShop ne publie pas de sommes de contrôle utilisables pour son cœur ni pour les modules : la couverture est partielle.'
        : 'Le plugin compare les fichiers du noyau et des extensions du dépôt officiel aux sommes de contrôle publiées par wordpress.org, et cherche des fichiers PHP dans le dossier des téléversements. Les extensions et thèmes premium ou sur mesure ne sont pas comparables.'),
      h('p', { class: 'muted', style: { margin: '8px 0 0' } }, 'Le contrôle s’exécute depuis le site lui-même : un attaquant qui en a pris le contrôle pourrait en fausser le résultat. Il complète une sauvegarde saine et une analyse externe, il ne les remplace pas.'))));

  if (integ?.core) {
    if (!shop) {
      root.append(integritySection(`Noyau ${kind}${integ.core.version ? ` ${integ.core.version}` : ''}`, integ.core,
        integ.core.known ? 'Tous les fichiers du noyau correspondent à la distribution officielle.' : 'Les sommes de contrôle de cette version n’ont pas pu être récupérées auprès de wordpress.org.'));
      const rows = [...integ.plugins].sort((a, b) => (b.modified.length + b.added.length) - (a.modified.length + a.added.length) || a.name.localeCompare(b.name, 'fr'));
      root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-head' }, h('h2', {}, 'Extensions'), h('span', { class: 'muted' }, `${integ.plugins.filter((p) => p.known).length} vérifiées sur ${integ.plugins.length}`)),
        rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Extension'), h('th', {}, 'Version'), h('th', {}, 'État'), h('th', {}, 'Fichiers'))),
          h('tbody', {}, ...rows.map((p) => {
            const bad = p.modified.length + p.added.length;
            return h('tr', {},
              h('td', {}, p.name), h('td', { class: 'mono' }, p.version || '—'),
              h('td', {}, !p.known ? h('span', { class: 'pill mute', title: p.skipped ? 'Contrôle interrompu (délai) : repris au prochain relevé' : 'Hors du dépôt officiel de wordpress.org, ou version inconnue de celui-ci' }, p.skipped ? 'Reporté' : 'Non vérifiable') : bad ? h('span', { class: 'pill crit' }, plural(bad, 'anomalie', 'anomalies')) : p.missing.length ? h('span', { class: 'pill warn' }, 'Fichiers manquants') : h('span', { class: 'pill ok' }, 'Conforme')),
              h('td', {}, bad || p.missing.length ? h('ul', { class: 'plain', style: { margin: 0, paddingLeft: '16px' } }, ...pathItems(p.modified, 'modifié'), ...pathItems(p.added, 'ajouté'), ...pathItems(p.missing, 'manquant')) : h('span', { class: 'muted' }, p.known ? `${p.checked} comparés` : '—')));
          })))) : h('div', { class: 'empty', style: { padding: '22px' } }, h('p', { style: { margin: 0 } }, 'Aucune extension à vérifier.'))));
    }
    const up = integ.uploads;
    root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'card-head' }, h('h2', {}, shop ? 'Fichiers PHP dans les dossiers de médias' : 'Fichiers PHP dans uploads'), h('span', { class: 'muted' }, `${up.scanned} fichiers parcourus${shop && integ.dirs?.length ? ` (${integ.dirs.join(', ')})` : ''}`),
        up.php.length ? h('span', { class: 'pill crit' }, plural(up.php.length + up.more, 'fichier', 'fichiers')) : h('span', { class: 'pill ok' }, 'Aucun')),
      up.php.length ? h('div', { class: 'card-pad' }, h('ul', { class: 'plain', style: { margin: 0, paddingLeft: '18px' } }, ...pathItems(up.php, 'PHP')), up.more ? h('p', { class: 'muted' }, `… et ${up.more} autre(s).`) : null,
        h('p', { class: 'muted' }, 'Ces dossiers ne devraient contenir que des images et des fichiers téléversés : un fichier PHP s’y trouve presque toujours à cause d’une intrusion.'))
        : up.truncated ? h('div', { class: 'card-pad' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Le parcours a été interrompu (trop de fichiers ou délai) : résultat partiel.')) : null));
  } else if (!integ?.error) {
    root.append(h('div', { class: 'empty', style: { padding: '28px' } }, h('p', {}, 'Aucun contrôle d’intégrité pour le moment. Cliquez sur « Actualiser » ; le plugin doit être en version 1.1 ou plus.')));
  }

  // Comptes administrateurs
  const flagged = (admins?.added?.length || 0) + (admins?.extra || 0);
  root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('h2', {}, 'Comptes administrateurs'), h('span', { class: 'muted' }, admins ? plural(admins.count, 'compte', 'comptes') : ''),
      !admins ? h('span', { class: 'pill mute' }, 'Non relevé') : flagged ? h('span', { class: 'pill crit' }, plural(flagged, 'à vérifier', 'à vérifier')) : h('span', { class: 'pill ok' }, 'Inchangés')),
    h('div', { class: 'card-pad' },
      !admins ? h('p', { class: 'muted', style: { margin: 0 } }, 'Le plugin n’a pas encore transmis le nombre d’administrateurs. Mettez-le à jour (version 1.1 ou plus) puis actualisez.')
        : h('div', {},
          h('p', { class: 'muted', style: { margin: '0 0 8px' } }, shop
            ? 'Le module ne renvoie que le nombre d’administrateurs actifs, sans identité ni mot de passe. SuricateWeb alerte quand ce nombre augmente.'
            : `Le plugin ne renvoie que le nombre d’administrateurs et ceux créés ces ${admins.windowDays || 30} derniers jours (identifiant de connexion et date), sans mot de passe ni e-mail. SuricateWeb alerte à chaque nouveau compte.`),
          admins.recent?.length ? h('ul', { class: 'plain', style: { margin: '0 0 8px', paddingLeft: '18px' } }, ...admins.recent.map((u) => {
            const isNew = admins.added?.some((a) => a.id === u.id);
            return h('li', {}, h('b', {}, u.login || `compte n° ${u.id}`), u.registered ? h('span', { class: 'muted' }, ` · créé le ${dday(u.registered)}`) : null, isNew ? h('span', { class: 'pill crit', style: { marginLeft: '8px' } }, 'Nouveau') : null);
          })) : null,
          admins.extra ? h('p', {}, h('span', { class: 'pill crit' }, plural(admins.extra, 'compte de plus', 'comptes de plus')), ' sans création récente : un compte existant a peut-être été promu administrateur.') : null,
          flagged ? h('button', { class: 'btn', onclick: guard(async () => { await api(`/watches/${w.id}/cms/admins/accept`, { method: 'POST' }); toast('Comptes enregistrés comme référence'); route(); }) }, ic('check'), 'Je connais ces comptes') : null))));
  return root;
}

// ───────────── Domaine & DNS ─────────────
const CHK_ICON = { ok: 'checkCircle', warn: 'alert', bad: 'alert', na: 'info' };

async function domainTab(w) {
  const d = await api(`/watches/${w.id}/domain`);
  const root = h('div', {});
  const dns = d.dns;
  const r = d.rdap && !d.rdap.unsupported && (d.rdap.registrar || d.rdap.expires) ? d.rdap : null;
  const sameSet = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

  for (const i of d.incidents) {
    root.append(h('div', { class: `incident ${i.severity === 'warning' ? 'warn' : ''}` }, ic('alert'), h('div', {}, h('b', {}, i.title), i.detail ? h('p', {}, i.detail) : null, h('small', {}, `Depuis ${rel(i.since)}`))));
  }
  if (!d.monitored.dns && !d.monitored.rdap) {
    root.append(h('div', { class: 'callout' }, ic('info'), h('div', {}, 'La surveillance DNS et celle du registre sont désactivées pour ce site. Activez-les dans « Modifier › Infrastructure et nom de domaine ».')));
  }

  const resolvers = Object.entries(d.resolvers || {});
  const split = dns && resolvers.some(([, ns]) => !sameSet(ns, dns.ns));
  const expDays = r?.expires ? daysLeft(r.expires) : null;
  const risky = (r?.status || []).filter((x) => /pending transfer|hold|redemption|pending delete|pending restore/.test(x));
  const list = [
    ['Serveurs de noms (DNS)', dns?.ns?.length ? dns.ns.join(', ') : 'En attente du premier contrôle', dns?.ns?.length ? 'ok' : 'na', 'Les serveurs qui répondent pour votre zone.'],
    ['Cohérence des résolveurs', !resolvers.length ? 'Résolveurs publics non joignables' : split ? `Divergence : ${resolvers.filter(([, ns]) => !sameSet(ns, dns.ns)).map(([n, ns]) => `${n} → ${ns.join(', ')}`).join(' · ')}` : `${resolvers.map(([n]) => n).join(', ')} concordent`, !resolvers.length ? 'na' : split ? 'warn' : 'ok', 'Cloudflare, Google et Quad9 interrogés en parallèle.'],
    ['Délégation au registre', r?.nameservers?.length ? r.nameservers.join(', ') : 'Non exposée par le registre', r?.nameservers?.length ? (dns?.ns?.length && !sameSet(r.nameservers, dns.ns) ? 'warn' : 'ok') : 'na', 'La liste officielle des serveurs de noms : elle change immédiatement, sans cache.'],
    ['Registrar', r?.registrar || '—', r?.registrar ? 'ok' : 'na', 'Un changement de registrar signale un transfert du domaine.'],
    ['Verrou anti-transfert', r ? lockLabel(r) : '—', !r ? 'na' : r.locked ? 'ok' : lockLabel(r) === 'Partiel' ? 'warn' : 'na', 'Empêche un transfert non autorisé vers un autre registrar.'],
    ['DNSSEC', r ? (r.dnssec === true ? 'Activé' : r.dnssec === false ? 'Désactivé' : 'Non exposé par le registre') : '—', r?.dnssec === true ? 'ok' : r?.dnssec === false ? 'warn' : 'na', 'Sa désactivation accompagne souvent un détournement de zone.'],
    ['Statut du domaine', r ? (r.status?.join(', ') || '—') : '—', risky.length ? 'bad' : r ? 'ok' : 'na', 'Alerte sur « pending transfer », « hold », « redemption », « pending delete ».'],
    ['Échéance', r?.expires ? `${dday(r.expires)} (${expDays < 0 ? 'expiré' : `dans ${expDays} j`})` : '—', expDays == null ? 'na' : expDays < 7 ? 'bad' : expDays < 30 ? 'warn' : 'ok', 'Alerte 30 jours, puis 7 jours avant expiration.'],
    ['Dernière modification', r?.changed ? dday(r.changed) : '—', 'na', r?.transferred ? `Dernier transfert enregistré : ${dday(r.transferred)}.` : 'Aucun transfert enregistré.'],
  ];
  root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, d.domain), h('span', { class: 'muted' }, d.zone && d.zone !== d.domain ? `zone DNS : ${d.zone}` : 'Intégrité du domaine')), h('span', { class: 'muted' }, r ? `registre vérifié ${rel(d.rdap.checkedAt)}` : '')),
    h('div', { class: 'chk' }, ...list.map(([k, v, lvl, hint]) => h('div', { class: `chk-row ${lvl}`, title: hint }, h('span', { class: 'chk-ic' }, ic(CHK_ICON[lvl])), h('span', { class: 'chk-k' }, k), h('span', { class: 'chk-v' }, v))))));

  const rec = dns ? [['A (IPv4)', dns.a], ['AAAA (IPv6)', dns.aaaa], ['CNAME', dns.cname], ['NS', dns.ns], ['MX', dns.mx], ['SPF', dns.spf ? [dns.spf] : []], ['DMARC', dns.dmarc ? [dns.dmarc] : []], ['CAA', dns.caa]] : [];
  root.append(h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-head' }, h('h2', {}, 'Enregistrements surveillés'), h('span', { class: 'muted' }, 'référence actuelle')),
    rec.length ? h('div', { class: 'rec' }, ...rec.map(([k, v]) => h('div', { class: 'rec-row' }, h('span', { class: 'rec-k' }, k), h('span', { class: 'rec-v mono' }, v?.length ? v.map((x) => h('div', {}, x)) : h('span', { class: 'muted' }, '—')))))
      : h('div', { class: 'empty', style: { padding: '28px' } }, h('p', { style: { margin: 0 } }, 'Les enregistrements apparaîtront après le premier contrôle.'))));

  root.append(h('div', { class: 'section-title' }, h('h2', {}, 'Historique des changements')));
  root.append(d.events.length ? alertList(d.events, false)
    : empty('shield', 'Aucun changement détecté', "Les serveurs de noms, le registrar, le verrou, DNSSEC et les enregistrements DNS sont stables depuis le début de la surveillance."));
  return root;
}

// ───────────── Historique des modifications ─────────────
async function changesTab(w, openSnap) {
  const hist = await api(`/watches/${w.id}/history`);
  if (!hist.length) return empty('file', 'Aucune version enregistrée', 'La première version apparaîtra après le premier contrôle.');
  if (openSnap) S.open.add(openSnap);
  const box = h('div', { class: 'card timeline' });
  const loadDiff = guard(async (snap, host) => {
    host.replaceChildren(h('div', { class: 'diff-note' }, 'Chargement…'));
    const d = await api(`/snapshots/${snap.id}/diff`);
    host.replaceChildren(renderDiff(d));
  });
  for (const snap of hist) {
    const m = snap.meta || {};
    const isBase = m.baseline;
    const diffHost = h('div', {});
    const item = h('div', { class: `tl-item ${S.open.has(snap.id) ? 'open' : ''}` });
    const head = h('div', { class: 'tl-head', tabindex: 0, role: 'button', onclick: () => {
      const open = item.classList.toggle('open');
      open ? S.open.add(snap.id) : S.open.delete(snap.id);
      if (open && !diffHost.firstChild && !isBase) loadDiff(snap, diffHost);
    } },
      h('div', { class: 'when' }, h('b', {}, dt(snap.ts)), h('span', {}, rel(snap.ts))),
      h('div', { class: 'sum' }, isBase ? 'Version de référence (premier contrôle)' : snap.title || '(sans titre)'),
      isBase ? h('span', { class: 'pill info' }, 'Référence') : h('span', { class: 'pm' }, h('span', { class: 'a' }, `+${m.added ?? 0}`), ' ', h('span', { class: 'd' }, `−${m.removed ?? 0}`)),
      !isBase && m.similarity != null ? h('span', { class: `pill ${m.similarity < 0.25 ? 'crit' : m.similarity < 0.8 ? 'warn' : ''}` }, `${Math.round(m.similarity * 100)} % identique`) : null,
      h('span', { class: 'chev' }, ic('chevron')));
    head.addEventListener('keydown', (e) => e.key === 'Enter' && head.click());
    item.append(head, diffHost);
    box.append(item);
    if (S.open.has(snap.id) && !isBase) loadDiff(snap, diffHost);
  }
  return box;
}

function renderDiff(d) {
  if (!d.hunks.length) return h('div', { class: 'diff-note' }, 'Aucune différence de texte.');
  const wrap = h('div', { class: 'diff' });
  for (const l of d.hunks) {
    if (l.t === 'skip') wrap.append(h('div', { class: 'skip' }, `⋯ ${plural(l.n, 'ligne identique', 'lignes identiques')} ⋯`));
    else wrap.append(h('div', { class: `ln ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}` }, h('span', { class: 'no' }, l.o ?? ''), h('span', { class: 'no' }, l.n ?? ''), h('span', {}, l.t === '=' ? '' : l.t), h('span', { class: 'tx' }, l.l)));
  }
  return wrap;
}

// ───────────── Alertes ─────────────
const SEV_ICON = { critical: 'alert', warning: 'alert', info: 'info', recovery: 'checkCircle' };
const SEV_LABEL = { critical: 'Critique', warning: 'Attention', info: 'Info', recovery: 'Rétabli' };

function alertList(alerts, showSite = true) {
  const box = h('div', { class: 'card' });
  let day = '';
  for (const a of alerts) {
    const d = new Date(a.ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    if (d !== day) { day = d; box.append(h('div', { class: 'day' }, d)); }
    box.append(h('div', { class: `alert ${a.read ? '' : 'unread'}` },
      h('div', { class: `sev ${a.severity}` }, ic(SEV_ICON[a.severity])),
      h('div', { class: 'body' },
        h('div', { class: 'top' }, h('b', {}, a.title), showSite ? h('a', { href: `#/sites/${a.watchId}` }, a.watchName) : null),
        a.detail ? h('div', { class: 'det' }, a.detail) : null,
        h('div', { class: 'meta' }, h('span', { title: new Date(a.ts).toLocaleString('fr-FR') }, `${dt(a.ts)} · ${rel(a.ts)}`),
          h('span', { class: `pill ${a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : a.severity === 'recovery' ? 'ok' : 'info'}` }, SEV_LABEL[a.severity]),
          a.snapshotId && a.prevSnapshotId ? h('a', { href: `#/sites/${a.watchId}/modifications/${a.snapshotId}` }, 'Voir les changements') : null,
          a.maintenance ? h('span', { class: 'chip', title: 'Retenue pendant une maintenance : non envoyée sur Telegram, reprise dans le message récapitulatif de fin.' }, ic('wrench'), 'Retenue (maintenance)') : a.notified ? h('span', { class: 'chip ok' }, ic('send'), 'Envoyé sur Telegram') : a.notifyError ? h('span', { class: 'chip crit', title: a.notifyError }, ic('alert'), 'Échec Telegram') : null))));
  }
  return box;
}

async function viewAlerts() {
  const q = S.alertSev ? `&severity=${S.alertSev}` : '';
  const [alerts, list] = await Promise.all([api(`/alerts?limit=100${q}`), api('/watches')]);
  S.watches = list;
  const root = h('div', {});
  const unread = alerts.filter((a) => !a.read).length;
  root.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Alertes'), h('p', {}, 'Tout ce que SuricateWeb a détecté, du plus récent au plus ancien.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: !list.some((w) => w.unread.critical + w.unread.warning + w.unread.info || w.incidents.some((i) => (i.key === 'rdap_expiring' || /^(cms_|php_eol)/.test(i.key)) && !i.acked)), onclick: guard(async () => { await api('/alerts/read', { method: 'POST', body: { all: true } }); toast('Toutes les alertes sont marquées comme lues'); route(); }) }, ic('check'), 'Tout marquer comme lu'))));
  root.append(h('div', { class: 'toolbar' }, h('div', { class: 'seg' }, ...[['', 'Toutes'], ['critical', 'Critiques'], ['warning', 'Attention'], ['info', 'Infos'], ['recovery', 'Rétablis']].map(([k, l]) =>
    h('button', { class: S.alertSev === k ? 'on' : '', onclick: () => { S.alertSev = k; route(); } }, l)))));
  void unread;
  root.append(alerts.length ? alertList(alerts) : empty('bell', 'Aucune alerte', "Tout est calme. Les alertes apparaîtront ici dès qu'une anomalie est détectée."));
  return root;
}

// ───────────── Formulaire d'ajout / modification ─────────────
const CHECK_DEFS = {
  'Contenu du site': [
    ['content', 'Contenu de la page', 'Toute modification ou remplacement du texte (défiguration, page écrasée).'],
    ['keywords', 'Mots-clés de piratage et de spam', '« Hacked by », pages par défaut du serveur, « domaine à vendre », spam pharmaceutique…'],
    ['title', 'Titre de la page', 'Alerte si la balise <title> change.'],
    ['scripts', 'Scripts chargés', "Nouveau fichier JavaScript : injection de malware ou de skimmer de cartes bancaires."],
    ['links', 'Liens, iframes et formulaires externes', 'Spam SEO injecté, iframes cachées, formulaires détournés vers un autre domaine.'],
    ['sizeDrop', 'Page vide ou effondrée', "Le contenu perd plus de 80 % de sa taille."],
  ],
  'Disponibilité et redirections': [
    ['status', 'Code HTTP', 'Erreurs 4xx et 5xx.'],
    ['redirect', 'Redirections', 'Redirection vers un autre domaine, retour en HTTP non chiffré.'],
    ['server', 'Logiciel serveur', 'Changement de l\'en-tête Server (migration, remplacement du serveur).'],
  ],
  'Infrastructure et nom de domaine': [
    ['tls', 'Certificat TLS', 'Expiration, invalidité, émetteur inattendu.'],
    ['dns', 'DNS', 'Changement des serveurs de noms (NS), de l\'adresse IP ou de la messagerie (MX).'],
    ['rdap', 'Nom de domaine (RDAP / WHOIS)', 'Changement de registrar, transfert, verrou retiré, échéance proche.'],
  ],
};

function drawer(title, body, foot) {
  const close = () => { ov.remove(); dr.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => e.key === 'Escape' && close();
  const ov = h('div', { class: 'overlay', onclick: close });
  const dr = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': title },
    h('div', { class: 'drawer-head' }, h('h2', {}, title), h('button', { class: 'btn ghost icon sm', 'aria-label': 'Fermer', onclick: close }, ic('x'))),
    h('div', { class: 'drawer-body' }, body), h('div', { class: 'drawer-foot' }, foot(close)));
  document.body.append(ov, dr);
  linkLabels(dr);
  document.addEventListener('keydown', esc);
  return { close, el: dr };
}

const INTERVALS = [[1, '1 minute'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure'], [180, '3 heures'], [360, '6 heures'], [720, '12 heures'], [1440, '24 heures']];

function openSiteForm(w, presetUrl = '', presetGroup = null) {
  const c = w?.config || { mode: 'site', checks: Object.fromEntries(Object.values(CHECK_DEFS).flat().map(([k]) => [k, true])), selector: '', excludeSelector: '', ignoreRegex: [], images: false, userAgent: '', timeoutS: 20, headers: {}, allowedHosts: [], failThreshold: 2, forbidden: [], required: [], minChangePct: 0, notify: true, minSeverity: '', screenshot: { enabled: true, interval: 60, fullPage: false, width: 1280, height: 800, delay: 3, interact: true, hideBanners: true } };
  const sc = c.screenshot;
  const SHOT_DELAYS = [[0, 'Aucune'], [2, '2 secondes'], [3, '3 secondes'], [5, '5 secondes'], [10, '10 secondes'], [20, '20 secondes'], [30, '30 secondes']];
  const SHOT_EVERY = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure'], [180, '3 heures'], [360, '6 heures'], [720, '12 heures'], [1440, '24 heures']];
  const SHOT_SIZES = [['1280x800', 'Ordinateur (1280 × 800)'], ['1920x1080', 'Grand écran (1920 × 1080)'], ['390x844', 'Mobile (390 × 844)']];
  const curSize = `${sc.width}x${sc.height}`;
  const interval = w?.interval || S.settings?.defaultInterval || 15;
  const f = {
    url: h('input', { class: 'input', placeholder: 'https://www.monsite.fr', value: w?.url || presetUrl, autocomplete: 'off', spellcheck: false }),
    name: h('input', { class: 'input', placeholder: 'Déduit de l\'adresse si vide', value: w?.name || '' }),
    interval: h('select', { class: 'input', value: String(interval) }, ...(INTERVALS.some(([v]) => v === interval) ? INTERVALS : [...INTERVALS, [interval, `${interval} minutes`]]).map(([v, l]) => h('option', { value: String(v) }, `Toutes les ${l}`.replace('Toutes les 1 minute', 'Chaque minute').replace('Toutes les 1 heure', 'Toutes les heures'))), ),
    tags: h('input', { class: 'input', placeholder: 'client-dupont, e-commerce', value: (w?.tags || []).join(', ') }),
    group: h('select', { class: 'input', value: String(w ? (w.groupId ?? '') : (presetGroup ?? '')) },
      h('option', { value: '' }, 'Sans groupe'),
      ...S.groups.map((g) => h('option', { value: String(g.id) }, g.name)),
      h('option', { value: '__new' }, '＋ Nouveau groupe…')),
    selector: h('input', { class: 'input mono', placeholder: 'main, #contenu, .article', value: c.selector }),
    exclude: h('input', { class: 'input mono', placeholder: '.horloge, #bandeau-cookies, .pub', value: c.excludeSelector }),
    ignore: h('textarea', { class: 'input mono', placeholder: '^Mis à jour le\n\\d+ visiteurs', value: c.ignoreRegex.join('\n') }),
    images: h('input', { type: 'checkbox', checked: c.images }),
    forbidden: h('textarea', { class: 'input', placeholder: 'un mot ou une phrase par ligne', value: c.forbidden.join('\n') }),
    required: h('textarea', { class: 'input', placeholder: 'ex. le nom de votre société ou un numéro de téléphone', value: c.required.join('\n') }),
    ua: h('input', { class: 'input', placeholder: S.settings?.userAgent || '', value: c.userAgent }),
    shotOn: h('input', { type: 'checkbox', checked: sc.enabled }),
    shotKeep: h('select', { class: 'input', value: String(sc.keep || 0) }, h('option', { value: '0' }, `Réglage général (${S.settings?.retention?.screenshots ?? 168})`), ...keepOptions(sc.keep).map((v) => h('option', { value: String(v) }, `${v} captures`))),
    shotEvery: h('select', { class: 'input', value: String(sc.interval) }, ...(SHOT_EVERY.some(([v]) => v === sc.interval) ? SHOT_EVERY : [...SHOT_EVERY, [sc.interval, `${sc.interval} minutes`]]).map(([v, l]) => h('option', { value: String(v) }, `Toutes les ${l}`.replace('Toutes les 1 heure', 'Toutes les heures')))),
    shotSize: h('select', { class: 'input', value: curSize }, ...(SHOT_SIZES.some(([v]) => v === curSize) ? SHOT_SIZES : [...SHOT_SIZES, [curSize, `${sc.width} × ${sc.height}`]]).map(([v, l]) => h('option', { value: v }, l))),
    shotFull: h('input', { type: 'checkbox', checked: sc.fullPage }),
    shotDelay: h('select', { class: 'input', value: String(sc.delay) }, ...(SHOT_DELAYS.some(([v]) => v === sc.delay) ? SHOT_DELAYS : [...SHOT_DELAYS, [sc.delay, `${sc.delay} secondes`]]).map(([v, l]) => h('option', { value: String(v) }, l))),
    shotInteract: h('input', { type: 'checkbox', checked: sc.interact }),
    shotBanners: h('input', { type: 'checkbox', checked: sc.hideBanners }),
    timeout: h('input', { class: 'input', type: 'number', min: 3, max: 60, value: c.timeoutS }),
    fails: h('input', { class: 'input', type: 'number', min: 1, max: 10, value: c.failThreshold }),
    minPct: h('input', { class: 'input', type: 'number', min: 0, max: 100, step: 0.5, value: c.minChangePct }),
    allowed: h('input', { class: 'input', placeholder: 'ex. boutique.monsite.fr, cdn.exemple.com', value: c.allowedHosts.join(', ') }),
    headers: h('textarea', { class: 'input mono', placeholder: 'Authorization: Basic …\nCookie: preview=1', value: Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join('\n') }),
    notify: h('input', { type: 'checkbox', checked: c.notify }),
    minSev: h('select', { class: 'input', value: c.minSeverity }, h('option', { value: '' }, 'Réglage général'), h('option', { value: 'info' }, 'Tout (infos incluses)'), h('option', { value: 'warning' }, 'Attention et critique'), h('option', { value: 'critical' }, 'Critique uniquement')),
    cmsType: h('select', { class: 'input', value: (c.cms?.type === 'wordpress' || c.cms?.type === 'prestashop') ? c.cms.type : '' }, h('option', { value: '' }, 'Aucun'), h('option', { value: 'wordpress' }, 'WordPress'), h('option', { value: 'prestashop' }, 'PrestaShop')),
    cmsToken: h('input', { class: 'input mono', value: c.cms?.token || '', autocomplete: 'off', spellcheck: false }),
    cmsPath: h('input', { class: 'input mono', placeholder: 'racine du site', value: c.cms?.path || '', autocomplete: 'off', spellcheck: false }),
    cmsAlerts: h('input', { type: 'checkbox', checked: c.cms?.alerts !== false }),
    cmsEvery: h('select', { class: 'input', value: String(c.cms?.intervalMin || 720) }, ...[[60, 'Toutes les heures'], [360, 'Toutes les 6 heures'], [720, 'Toutes les 12 heures'], [1440, 'Toutes les 24 heures'], [10080, 'Tous les 7 jours']].map(([v, l]) => h('option', { value: String(v) }, l))),
    cmsSecurity: h('input', { type: 'checkbox', checked: c.cms?.security !== false }),
    pages: h('textarea', { class: 'input mono', rows: 4, placeholder: '/panier | Panier\n/contact\n/mon-compte | Connexion', value: (c.pages || []).map((p) => (p.label ? `${p.url} | ${p.label}` : p.url)).join('\n') }),
    statusOn: h('input', { type: 'checkbox', checked: !!c.statusPage?.enabled }),
    statusTitle: h('input', { class: 'input', placeholder: 'Nom affiché sur la page (par défaut : le nom du site)', maxlength: 80, value: c.statusPage?.title || '' }),
  };
  let statusToken = c.statusPage?.token || '';
  // Durée d'historique couverte par la limite choisie, à la fréquence choisie.
  const keepHint = h('span', { class: 'hint' }, '');
  const syncKeep = () => {
    const keep = Number(f.shotKeep.value) || (S.settings?.retention?.screenshots ?? 168);
    keepHint.textContent = `Environ ${spanLabel(keep * Number(f.shotEvery.value))} d'historique à cette fréquence. Les plus anciennes sont supprimées au fil des captures. Les captures manuelles et d'alerte ont leur propre quota (jusqu'à 100).`;
  };
  f.shotKeep.addEventListener('change', syncKeep);
  f.shotEvery.addEventListener('change', syncKeep);
  syncKeep();
  const checks = {};
  const toggle = (input, title, desc) => h('label', { class: 'toggle-row' }, h('div', { class: 'tt' }, h('b', {}, title), desc ? h('span', {}, desc) : null), h('span', { class: 'switch' }, input, h('i')));
  // Les groupes « contenu » et « disponibilité » n'ont pas de sens pour un domaine seul : masqués dans ce mode.
  const siteOnly = (el) => (el.setAttribute('data-site-only', ''), el);
  const groups = Object.entries(CHECK_DEFS).map(([g, items], i) => {
    const el = h('div', { class: 'check-group' }, h('h4', {}, g),
      ...items.map(([k, t, d]) => {
        checks[k] = h('input', { type: 'checkbox', checked: !!c.checks[k] });
        return k === 'tls' ? siteOnly(toggle(checks[k], t, d)) : toggle(checks[k], t, d);
      }));
    return i < 2 ? siteOnly(el) : el;
  });

  let mode = c.mode === 'domain' ? 'domain' : 'site';
  const MODES = [['site', 'Site web', 'Disponibilité, contenu, certificat, DNS et domaine.'], ['domain', 'Domaine seul', 'DNS et registre uniquement : pour un domaine sans site web (messagerie, nom réservé).']];
  const modeHint = h('span', { class: 'hint' }, MODES.find(([k]) => k === mode)[2]);
  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Type de surveillance' }, ...MODES.map(([k, l]) => h('button', { type: 'button', class: k === mode ? 'on' : '', onclick: (e) => {
    mode = k;
    modeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
    modeHint.textContent = MODES.find(([m]) => m === k)[2];
    $('form', document.querySelector('.drawer')).classList.toggle('domain-mode', k === 'domain');
  } }, l)));

  const testOut = h('div', { class: 'test-result' });
  const testBtn = h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
    testBtn.disabled = true;
    testOut.replaceChildren(h('span', { class: 'muted' }, 'Test en cours…'));
    const r = await api('/test-url', { method: 'POST', body: { url: f.url.value } }).finally(() => (testBtn.disabled = false));
    testOut.replaceChildren(...(r.ok ? [
      h('span', { class: `chip ${r.status < 400 ? 'ok' : 'crit'}` }, `HTTP ${r.status}`), h('span', { class: 'chip' }, fmtMs(r.ms)),
      r.title ? h('span', { class: 'muted' }, `« ${r.title.slice(0, 60)} »`) : null,
      r.redirected ? h('span', { class: `chip ${r.offDomain ? 'warn' : ''}` }, `redirige vers ${host(r.finalUrl)}`) : null,
    ] : [h('span', { class: 'chip crit' }, ic('alert'), r.error)]).filter(Boolean));
    if (r.ok && !f.name.value && r.title) f.name.placeholder = r.title.slice(0, 40);
  }) }, 'Tester');

  const cmsEndpointEl = h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, '');
  const cmsBox = h('div', {});
  const syncCms = () => {
    const on = f.cmsType.value === 'wordpress' || f.cmsType.value === 'prestashop';
    cmsBox.hidden = !on;
    if (on && !f.cmsToken.value) f.cmsToken.value = randomToken();
    const kind = f.cmsType.value === 'prestashop' ? 'PrestaShop' : 'WordPress';
    cmsEndpointEl.textContent = on ? cmsUrl(f.url.value, f.cmsType.value, f.cmsPath.value) : '';
    cmsBox.querySelector('[data-cms-kind]')?.replaceChildren(document.createTextNode(kind));
  };
  cmsBox.append(
    h('div', { class: 'field' }, h('label', {}, 'Jeton'), h('div', { class: 'input-group' }, f.cmsToken,
      h('button', { class: 'btn', type: 'button', onclick: () => { f.cmsToken.value = randomToken(); toast('Nouveau jeton — enregistrez, puis collez-le dans le plugin'); } }, 'Générer'),
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await navigator.clipboard.writeText(f.cmsToken.value); toast('Jeton copié'); }) }, 'Copier')),
      h('span', { class: 'hint' }, 'À coller dans le plugin. Sans ce jeton, le plugin ne répond pas.')),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Dossier'), f.cmsPath, h('span', { class: 'hint' }, 'Seulement si le CMS n’est pas à la racine du domaine (ex. blog).')),
      h('div', { class: 'field' }, h('label', {}, 'Fréquence du relevé'), f.cmsEvery)),
    h('div', { class: 'field' }, h('label', {}, 'Adresse interrogée'), cmsEndpointEl),
    toggle(f.cmsAlerts, 'Alerter si des mises à jour tardent ou si PHP n’est plus maintenu', 'Alerte Telegram quand une mise à jour reste en attente plus longtemps que le délai réglé dans Réglages, ou quand la version de PHP ne reçoit plus de correctifs de sécurité. À couper si vous ne maîtrisez pas ces versions (hébergement mutualisé, site client).'),
    toggle(f.cmsSecurity, 'Surveiller l’intégrité des fichiers et les comptes administrateurs', 'Alerte Telegram si un fichier du noyau ou d’une extension du dépôt officiel ne correspond plus aux sommes de contrôle de wordpress.org, si un fichier PHP apparaît dans le dossier des téléversements, ou si un nouvel administrateur est créé. Sous PrestaShop, seuls les dossiers d’images et de téléversements sont contrôlés. Nécessite la version 1.1 du plugin.'),
    h('p', {}, 'Téléchargez le plugin ', h('span', { 'data-cms-kind': '' }, ''), ', installez-le, activez-le, puis collez le jeton.',
      h('span', {}, ' '),
      h('a', { href: '/api/plugins/wordpress.zip' }, 'WordPress'), ' · ', h('a', { href: '/api/plugins/prestashop.zip' }, 'PrestaShop')),
  );
  f.cmsType.addEventListener('change', syncCms);
  f.cmsPath.addEventListener('input', syncCms);
  f.url.addEventListener('input', syncCms);
  syncCms();

  const statusUrl = () => `${(S.settings?.baseUrl || location.origin).replace(/\/+$/, '')}/status/${statusToken}`;
  const statusLink = h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, '');
  const statusBox = h('div', { class: 'field' }, h('label', {}, 'Adresse publique'),
    statusLink,
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
      h('button', { class: 'btn sm', type: 'button', onclick: guard(async () => { if (!statusToken) return toast('Enregistrez d’abord le site pour obtenir l’adresse'); await navigator.clipboard.writeText(statusUrl()); toast('Adresse copiée'); }) }, 'Copier'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { statusToken = randomToken(); syncStatus(); toast('Nouvelle adresse — enregistrez ; l’ancienne cessera de fonctionner'); } }, 'Nouvelle adresse')));
  const syncStatus = () => { statusLink.textContent = statusToken ? statusUrl() : 'L’adresse apparaîtra après l’enregistrement.'; };
  syncStatus();

  const body = h('form', { class: mode === 'domain' ? 'domain-mode' : '', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'field' }, h('label', {}, 'Type de surveillance'), modeSeg, modeHint),
    h('div', { class: 'field' }, h('label', {}, 'Adresse du site ou domaine'), h('div', { class: 'input-group' }, f.url, siteOnly(testBtn)), siteOnly(testOut)),
    h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Nom'), f.name), h('div', { class: 'field' }, h('label', {}, 'Fréquence de contrôle'), f.interval)),
    h('div', { class: 'field' }, h('label', {}, 'Groupe'), f.group, h('span', { class: 'hint' }, 'Pour classer vos sites dans la liste (par client, par projet…). Vous pouvez aussi les glisser-déposer.')),
    h('div', { class: 'field' }, h('label', {}, 'Étiquettes'), f.tags, h('span', { class: 'hint' }, 'Séparées par des virgules — pratique pour regrouper par client.')),
    siteOnly(details('WordPress / PrestaShop', [
      h('div', { class: 'field' }, h('label', {}, 'CMS'), f.cmsType, h('span', { class: 'hint' }, 'SuricateWeb interroge un plugin installé sur le site pour lire la version de PHP et les mises à jour. Le plugin n’envoie rien de lui-même.')),
      cmsBox,
    ], !!(c.cms?.type))),
    siteOnly(details('Pages supplémentaires', [
      h('div', { class: 'field' }, h('label', {}, 'Autres pages à surveiller'), f.pages,
        h('span', { class: 'hint' }, 'Une par ligne : un chemin (/panier) ou une adresse du même site, puis « | » et un nom facultatif. 10 pages au plus. Panier, paiement, connexion et contact sont les cibles favorites des pirates : SuricateWeb y vérifie la disponibilité, les textes suspects, les nouveaux scripts, iframes et formulaires détournés. Ces pages ne comptent pas dans la disponibilité du site.')),
    ], !!(c.pages && c.pages.length))),
    siteOnly(details('Page de statut publique', [
      toggle(f.statusOn, 'Publier une page de statut en lecture seule', 'Une adresse à donner à votre client : disponibilité sur 90 jours, pannes et maintenances. Aucune alerte de sécurité ni détail technique n’y figure. Toute personne qui connaît l’adresse peut la consulter.'),
      h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Titre affiché'), f.statusTitle),
      statusBox,
    ], !!c.statusPage?.enabled)),
    h('h3', { style: { margin: '22px 0 4px' } }, 'Que surveiller ?'), h('p', { class: 'muted', style: { marginBottom: '8px' } }, 'La configuration recommandée surveille tout. Désactivez ce qui produit trop de bruit sur ce site.'),
    ...groups,
    siteOnly(details('Capture d\'écran', [
      S.settings?.screenshots?.allowed === false
        ? h('div', { class: 'callout', style: { marginBottom: '12px' } }, ic('info'), h('div', {}, 'Les captures d\'écran ne sont pas incluses dans votre forfait : elles resteront inactives tant que vous n\'aurez pas changé de forfait.')) : null,
      S.settings?.screenshots?.available === false
        ? h('div', { class: 'callout', style: { marginBottom: '12px' } }, ic('info'), h('div', {}, 'Aucun navigateur détecté sur le serveur : les captures sont inactives. Installez Chrome ou Chromium, ou définissez CHROME_PATH.')) : null,
      toggle(f.shotOn, 'Capturer le site régulièrement', 'Un aperçu visuel à jour, et l\'historique des changements d\'apparence.'),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('div', { class: 'field' }, h('label', {}, 'Fréquence'), f.shotEvery),
        h('div', { class: 'field' }, h('label', {}, 'Format de la fenêtre'), f.shotSize)),
      h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Captures à conserver'), f.shotKeep, keepHint,
      ),
      toggle(f.shotFull, 'Capturer la page entière', 'Toute la hauteur de la page (5 000 px maximum), plutôt que la seule partie visible à l\'ouverture.'),
      h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Attente après le chargement'), f.shotDelay,
        h('span', { class: 'hint' }, 'Laisse finir les animations et les sliders. Le réseau et le défilement de la page sont de toute façon attendus avant la capture.')),
      toggle(f.shotInteract, 'Simuler un visiteur', 'Mouvement de souris et molette, pour réveiller les scripts que certains sites retardent « jusqu\'à la première interaction » (WP Rocket, NitroPack…). Sans cela, un slider ou un menu peut rester vide. Peut compter une visite dans vos statistiques à chaque capture.'),
      toggle(f.shotBanners, 'Masquer les bandeaux de cookies', 'Évite qu\'un bandeau de consentement recouvre la page dans l\'aperçu.'),
    ], true)),
    siteOnly(details('Filtrer le contenu comparé', [
      h('div', { class: 'field' }, h('label', {}, 'Surveiller uniquement cet élément (sélecteur CSS)'), f.selector, h('span', { class: 'hint' }, 'Vide = toute la page. Les mots-clés de piratage restent vérifiés sur la page entière.')),
      h('div', { class: 'field' }, h('label', {}, 'Ignorer ces éléments (sélecteur CSS)'), f.exclude, h('span', { class: 'hint' }, 'Horloges, compteurs de visites, bandeaux publicitaires…')),
      h('div', { class: 'field' }, h('label', {}, 'Ignorer les lignes correspondant à ces expressions régulières'), f.ignore, h('span', { class: 'hint' }, 'Une par ligne, insensible à la casse.')),
      toggle(f.images, 'Suivre aussi les images', 'Détecte le remplacement d\'une image par une autre (peut être bruyant si bannières rotatives).'),
    ])),
    siteOnly(details('Mots-clés personnalisés', [
      h('div', { class: 'field' }, h('label', {}, 'Textes interdits'), f.forbidden, h('span', { class: 'hint' }, 'Alerte critique si l\'un d\'eux apparaît. S\'ajoute à la liste intégrée (Réglages).')),
      h('div', { class: 'field' }, h('label', {}, 'Textes obligatoires'), f.required, h('span', { class: 'hint' }, 'Alerte critique si l\'un d\'eux disparaît — idéal pour détecter une page remplacée.')),
    ])),
    details('Avancé', [
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Seuil de modification (%)'), f.minPct, h('span', { class: 'hint' }, 'Ignore les changements plus petits.')), h('div', { class: 'field' }, h('label', {}, 'Échecs avant alerte « hors ligne »'), f.fails, h('span', { class: 'hint' }, 'Évite les fausses alertes.'))),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Délai maximal (secondes)'), f.timeout), h('div', { class: 'field' }, h('label', {}, 'User-Agent'), f.ua)),
      h('div', { class: 'field' }, h('label', {}, 'Redirections autorisées vers'), f.allowed, h('span', { class: 'hint' }, 'Domaines vers lesquels une redirection est normale.')),
      h('div', { class: 'field' }, h('label', {}, 'En-têtes HTTP personnalisés'), f.headers, h('span', { class: 'hint' }, 'Un par ligne, « Nom: valeur ». Pour les sites protégés ou en préproduction.')),
      toggle(f.notify, 'Notifier sur Telegram', 'Désactivez pour ne garder que l\'historique.'),
      h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', {}, 'Niveau minimal des notifications'), f.minSev),
    ]));

  drawer(w ? `Modifier « ${w.name} »` : 'Ajouter un site', body, (close) => [
    h('button', { class: 'btn', onclick: close }, 'Annuler'),
    h('button', { class: 'btn primary', onclick: guard(async (e) => {
      const btn = e.currentTarget;
      const list = (el, sep = /\n/) => el.value.split(sep).map((s) => s.trim()).filter(Boolean);
      const headers = {};
      for (const line of list(f.headers)) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      const payload = {
        url: f.url.value, name: f.name.value, interval: Number(f.interval.value), tags: list(f.tags, /,/),
        groupId: f.group.value === '' ? null : Number(f.group.value),
        config: {
          mode,
          screenshot: { enabled: f.shotOn.checked, interval: Number(f.shotEvery.value), fullPage: f.shotFull.checked, width: Number(f.shotSize.value.split('x')[0]), height: Number(f.shotSize.value.split('x')[1]), delay: Number(f.shotDelay.value), interact: f.shotInteract.checked, hideBanners: f.shotBanners.checked, keep: Number(f.shotKeep.value) },
          checks: Object.fromEntries(Object.entries(checks).map(([k, el]) => [k, el.checked])),
          selector: f.selector.value, excludeSelector: f.exclude.value, ignoreRegex: list(f.ignore), images: f.images.checked,
          forbidden: list(f.forbidden), required: list(f.required), userAgent: f.ua.value, timeoutS: Number(f.timeout.value), failThreshold: Number(f.fails.value),
          minChangePct: Number(f.minPct.value), allowedHosts: list(f.allowed, /[,\n]/), headers, notify: f.notify.checked, minSeverity: f.minSev.value,
          cms: mode === 'domain' ? { type: '' } : { type: f.cmsType.value, token: f.cmsToken.value, path: f.cmsPath.value, intervalMin: Number(f.cmsEvery.value), alerts: f.cmsAlerts.checked, security: f.cmsSecurity.checked },
          pages: mode === 'domain' ? [] : list(f.pages),
          statusPage: { enabled: mode !== 'domain' && f.statusOn.checked, token: statusToken, title: f.statusTitle.value },
        },
      };
      btn.disabled = true;
      try {
        const r = await api(w ? `/watches/${w.id}` : '/watches', { method: w ? 'PUT' : 'POST', body: payload });
        close();
        toast(w ? 'Modifications enregistrées' : 'Site ajouté — premier contrôle en cours');
        if (w) route(); else location.hash = `#/sites/${r.id}`;
      } finally { btn.disabled = false; }
    }) }, w ? 'Enregistrer' : 'Commencer la surveillance'),
  ]);
  // « ＋ Nouveau groupe… » : on crée le groupe sans quitter le formulaire, puis on le sélectionne.
  let prevGroup = f.group.value;
  f.group.addEventListener('change', guard(async () => {
    if (f.group.value !== '__new') { prevGroup = f.group.value; return; }
    const r = await groupDialog();
    if (!r) { f.group.value = prevGroup; return; }
    const g = await api('/groups', { method: 'POST', body: r });
    S.groups.push(g);
    f.group.insertBefore(h('option', { value: String(g.id) }, g.name), f.group.lastChild);
    f.group.value = prevGroup = String(g.id);
  }));
  setTimeout(() => (w ? f.name : f.url).focus(), 50);
}

const details = (title, kids, open = false) => h('details', { class: 'acc', open }, h('summary', {}, title, ic('chevron')), h('div', { class: 'in' }, kids));

// ───────────── Réglages ─────────────
async function viewSettings() {
  const s = await api('/settings');
  S.settings = s;
  const t = s.telegram;
  const f = {
    token: h('input', { class: 'input mono', placeholder: t.tokenSet ? t.tokenMasked + '  (déjà enregistré)' : '123456789:AAF…', autocomplete: 'off', spellcheck: false }),
    chat: h('input', { class: 'input mono', placeholder: 'ex. 123456789 ou -1001234567890', value: t.chatId }),
    enabled: h('input', { type: 'checkbox', checked: t.enabled }),
    recovery: h('input', { type: 'checkbox', checked: t.sendRecovery }),
    diff: h('input', { type: 'checkbox', checked: t.includeDiff }),
    photo: h('input', { type: 'checkbox', checked: t.sendScreenshot, disabled: !s.screenshots.available }),
    buttons: h('input', { type: 'checkbox', checked: t.buttons !== false }),
    minSev: h('select', { class: 'input', value: t.minSeverity }, h('option', { value: 'info' }, 'Tout, y compris les infos'), h('option', { value: 'warning' }, 'Attention et critique (recommandé)'), h('option', { value: 'critical' }, 'Critique uniquement')),
    base: h('input', { class: 'input', placeholder: 'http://monserveur:3000 (pour les liens dans les messages)', value: s.baseUrl }),
    interval: h('select', { class: 'input', value: String(s.defaultInterval) }, ...INTERVALS.map(([v, l]) => h('option', { value: String(v) }, l))),
    ua: h('input', { class: 'input', value: s.userAgent }),
    keepAll: h('select', { class: 'input', value: String(s.retention.screenshots) }, ...keepOptions(s.retention.screenshots).map((v) => h('option', { value: String(v) }, `${v} captures`))),
    cmsDays: h('select', { class: 'input', value: String(s.cmsAfterDays) }, ...[...new Set([1, 3, 7, 14, 30, s.cmsAfterDays])].sort((a, b) => a - b).map((v) => h('option', { value: String(v) }, `${v} ${v > 1 ? 'jours' : 'jour'}${v === 7 ? ' (par défaut)' : ''}`))),
    kw: h('textarea', { class: 'input mono', style: { minHeight: '190px' }, value: s.builtinKeywords.join('\n') }),
  };
  const toggle = (input, title, desc) => h('label', { class: 'toggle-row' }, h('div', { class: 'tt' }, h('b', {}, title), h('span', {}, desc)), h('span', { class: 'switch' }, input, h('i')));
  const chats = h('div', { class: 'chat-list' });

  const tgBody = () => ({ token: f.token.value.trim(), chatId: f.chat.value.trim() });
  const detect = guard(async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api('/telegram/detect', { method: 'POST', body: tgBody() });
      if (!r.chats.length) { chats.replaceChildren(h('p', { class: 'muted' }, `Bot @${r.bot} reconnu, mais aucune conversation trouvée. Ouvrez Telegram, envoyez /start à votre bot, puis réessayez.`)); return; }
      chats.replaceChildren(...r.chats.map((c) => h('div', { class: 'chat' }, h('div', {}, h('b', {}, c.title), h('span', { class: 'muted' }, `  ·  ${c.type} · ${c.id}`)),
        h('button', { class: 'btn sm', onclick: () => { f.chat.value = c.id; chats.replaceChildren(); toast('Identifiant renseigné — pensez à enregistrer'); } }, 'Utiliser'))));
    } finally { b.disabled = false; }
  });
  const test = guard(async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await api('/telegram/test', { method: 'POST', body: tgBody() }); toast(`Message envoyé via @${r.bot} — vérifiez Telegram`); } finally { b.disabled = false; }
  });
  const save = guard(async () => {
    S.settings = await api('/settings', { method: 'PUT', body: {
      telegram: { token: f.token.value.trim(), chatId: f.chat.value.trim(), enabled: f.enabled.checked, sendRecovery: f.recovery.checked, includeDiff: f.diff.checked, sendScreenshot: f.photo.checked, buttons: f.buttons.checked, minSeverity: f.minSev.value },
      baseUrl: f.base.value, defaultInterval: Number(f.interval.value), retention: { screenshots: Number(f.keepAll.value) }, cmsAfterDays: Number(f.cmsDays.value), userAgent: f.ua.value, builtinKeywords: f.kw.value.split('\n'),
    } });
    toast('Réglages enregistrés');
    mountShell(); route();
  });

  const importInput = h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: guard(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = await api('/import', { method: 'POST', body: JSON.parse(await file.text()) });
    toast(`${plural(r.added, 'site importé', 'sites importés')}${r.skipped ? `, ${r.skipped} ignoré(s)` : ''}`);
  }) });

  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Réglages'), h('p', {}, 'Notifications, détection et sécurité de SuricateWeb.')), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: save }, ic('check'), 'Enregistrer'))),
    h('div', { class: 'settings' },
      h('section', { class: 'card card-pad' },
        h('h2', { style: { marginBottom: '4px' } }, 'Notifications Telegram'),
        h('p', { class: 'muted', style: { marginBottom: '16px' } }, 'Les alertes arrivent directement sur votre téléphone, avec un extrait des changements.'),
        h('ol', { class: 'steps' },
          h('li', {}, h('span', {}, 'Dans Telegram, ouvrez ', h('b', {}, '@BotFather'), ', envoyez ', h('kbd', {}, '/newbot'), ' et copiez le jeton fourni.')),
          h('li', {}, h('span', {}, 'Collez-le ci-dessous, puis envoyez ', h('kbd', {}, '/start'), ' à votre nouveau bot (ou ajoutez-le dans un groupe).')),
          h('li', {}, h('span', {}, 'Cliquez sur « Détecter » pour retrouver automatiquement votre identifiant de conversation, puis sur « Tester ».'))),
        h('div', { class: 'field' }, h('label', {}, 'Jeton du bot'), f.token),
        h('div', { class: 'field' }, h('label', {}, 'Identifiant de conversation (chat ID)'), h('div', { class: 'input-group' }, f.chat, h('button', { class: 'btn', onclick: detect }, ic('search'), 'Détecter'), h('button', { class: 'btn', onclick: test }, ic('send'), 'Tester')), chats),
        toggle(f.enabled, 'Notifications actives', 'Coupe tous les envois Telegram sans perdre la configuration.'),
        toggle(f.recovery, 'Prévenir du rétablissement', 'Message « ✅ Rétabli » quand un incident disparaît.'),
        toggle(f.diff, 'Joindre un extrait des changements', 'Les premières lignes ajoutées / supprimées dans le message.'),
        toggle(f.photo, 'Joindre une capture d\'écran aux alertes critiques', s.screenshots.available ? 'Une photo de la page au moment d\'une défiguration, d\'un script injecté ou d\'une redirection : on voit tout de suite ce que voient les visiteurs.' : 'Indisponible : aucun navigateur (Chrome / Chromium) détecté sur le serveur.'),
        toggle(f.buttons, 'Boutons « Marquer comme lu » et « Ouvrir dans SuricateWeb »', 'Sous chaque alerte Telegram. « Marquer comme lu » est reçu par SuricateWeb en interrogeant Telegram : aucune adresse publique n’est nécessaire. « Ouvrir dans SuricateWeb » apparaît si l’adresse publique de SuricateWeb, plus bas, est utilisable.'),
        h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', {}, 'Niveau minimal des notifications'), f.minSev),
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Adresse de SuricateWeb (optionnel)'), f.base, h('span', { class: 'hint' }, 'Donne son adresse au bouton « Ouvrir dans SuricateWeb » sous chaque message. Elle doit être joignable depuis un téléphone : pas de localhost ni de réseau local.'))),
      h('section', { class: 'card card-pad' },
        h('h2', { style: { marginBottom: '14px' } }, 'Détection'),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Fréquence par défaut'), f.interval), h('div', { class: 'field' }, h('label', {}, 'User-Agent par défaut'), f.ua)),
        h('div', { class: 'field' }, h('label', {}, 'Mises à jour WordPress / PrestaShop : alerter après'), f.cmsDays,
          h('span', { class: 'hint' }, 'Une mise à jour du CMS, d’une extension ou d’un thème qui reste en attente plus longtemps que ce délai déclenche une alerte (le noyau devient critique au bout de 30 jours). Peut se couper site par site.')),
        h('div', { class: 'field' }, h('label', {}, 'Captures d\'écran conservées par site (par défaut)'), f.keepAll,
          h('span', { class: 'hint' }, `Au-delà, les plus anciennes sont supprimées. Chaque site peut avoir sa propre limite (Modifier › Capture d'écran) ; les captures manuelles et d'alerte ont leur quota, jusqu'à 100. Espace utilisé aujourd'hui : ${s.screenshots.usage.count} captures, ${fmtBytes(s.screenshots.usage.bytes)}.`)),
        h('div', { class: 'toggle-row', style: { borderTop: 0, paddingTop: 0, marginBottom: '14px' } }, h('div', { class: 'tt' }, h('b', {}, 'Navigateur pour les captures d\'écran'),
          h('span', {}, s.screenshots.available ? s.screenshots.browser : 'Aucun Chrome / Chromium détecté : installez-en un ou définissez CHROME_PATH.')),
          h('span', { class: `chip ${s.screenshots.available ? 'ok' : 'warn'}` }, ic(s.screenshots.available ? 'check' : 'alert'), s.screenshots.available ? 'Détecté' : 'Introuvable')),
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Liste intégrée de mots-clés suspects'), f.kw,
          h('span', { class: 'hint' }, 'Un par ligne. Détectés dans le texte de chaque page : revendications de pirates, pages par défaut de serveur, domaine à vendre, spam.'),
          h('div', {}, h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: () => { f.kw.value = s.defaultKeywords.join('\n'); } }, 'Rétablir la liste par défaut')))),
      S.auth?.accountApi ? accountSecurityCard() : h('section', { class: 'card card-pad' },
        h('h2', { style: { marginBottom: '4px' } }, 'Sécurité'),
        h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'L\'accès à SuricateWeb est protégé par un identifiant et un mot de passe définis hors de l\'application.'),
        h('div', { class: 'toggle-row' }, h('div', { class: 'tt' }, h('b', {}, 'Identifiant de connexion'), h('span', {}, 'Variable SURICATE_USER')), h('span', { class: 'chip' }, ic('lock'), s.authUser)),
        h('p', { class: 'hint muted', style: { marginTop: '12px' } }, 'Pour changer l\'identifiant ou le mot de passe, modifiez SURICATE_USER et SURICATE_PASSWORD dans le fichier .env (ou dans les variables d\'environnement de votre hébergement), puis redémarrez SuricateWeb. Toutes les sessions ouvertes seront alors déconnectées.')),
      h('section', { class: 'card card-pad' },
        h('h2', { style: { marginBottom: '4px' } }, 'Données'),
        h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Exportez la liste de vos sites et leur configuration, ou importez-en une.'),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('a', { class: 'btn', href: '/api/export', download: 'suricate-sites.json' }, ic('download'), 'Exporter'),
          h('button', { class: 'btn', onclick: () => importInput.click() }, ic('upload'), 'Importer'), importInput))));
}

// ───────────── Sécurité du compte (version hébergée) ─────────────
// Affichée quand le fournisseur d'authentification annonce `accountApi: true` dans GET /api/auth (voir docs/couche-cloud.md §3.1) :
// changer son mot de passe, fermer ses autres connexions, activer ou retirer la double authentification (TOTP).
// Le secret TOTP s'affiche en texte et en lien otpauth:// : le cœur n'a aucune dépendance, donc pas de code QR ici.
function accountSecurityCard() {
  const body = h('div', {});
  const card = h('section', { class: 'card card-pad', id: 'account-security' }, h('h2', { style: { marginBottom: '4px' } }, 'Sécurité du compte'), body);
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  const sub = (title) => h('h3', { style: { margin: '22px 0 8px', fontSize: '14px' } }, title);

  const load = async () => {
    try {
      render(await api('/account/security'));
    } catch (e) {
      body.replaceChildren(h('p', { class: 'muted' }, e.message));
    }
  };

  function render(sec, reveal = {}) {
    // Mot de passe
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', id: 'sec-current' });
    const nxt = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', id: 'sec-next' });
    const changePw = guard(async (e) => {
      e.preventDefault();
      await api('/account/password', { method: 'POST', body: { current: cur.value, next: nxt.value } });
      cur.value = nxt.value = '';
      toast('Mot de passe modifié. Vos autres connexions ont été fermées.');
      load();
    });

    // Autres connexions
    const revoke = guard(async () => {
      const r = await api('/account/sessions/revoke-others', { method: 'POST' });
      toast(r.revoked ? `${r.revoked} autre${r.revoked > 1 ? 's' : ''} connexion${r.revoked > 1 ? 's' : ''} fermée${r.revoked > 1 ? 's' : ''}` : 'Aucune autre connexion ouverte');
      load();
    });

    const nodes = [
      h('div', { class: 'toggle-row', style: { borderTop: 0, paddingTop: 0 } }, h('div', { class: 'tt' }, h('b', {}, 'Adresse de connexion'), h('span', {}, sec.email))),
      sub('Mot de passe'),
      h('form', { onsubmit: changePw },
        h('div', { class: 'row' }, field('Mot de passe actuel', cur), field('Nouveau mot de passe', nxt, '10 caractères au moins.')),
        h('button', { class: 'btn', type: 'submit' }, 'Changer le mot de passe')),
      sub('Connexions'),
      h('p', { class: 'muted', style: { marginBottom: '8px' } }, `${sec.sessions} connexion${sec.sessions > 1 ? 's' : ''} ouverte${sec.sessions > 1 ? 's' : ''} (celle-ci comprise).`),
      h('button', { class: 'btn', type: 'button', onclick: revoke }, 'Fermer les autres connexions'),
    ];

    if (sec.twofa?.available) nodes.push(sub('Double authentification'), twofaBlock(sec, reveal));
    body.replaceChildren(...nodes);
    linkLabels(body);
  }

  function twofaBlock(sec, reveal) {
    // Codes de secours tout juste générés : montrés UNE fois, avant tout autre contenu.
    if (reveal.recoveryCodes) {
      return h('div', {},
        h('p', { style: { marginBottom: '8px' } }, h('b', {}, 'Double authentification activée.'), ' Conservez ces codes de secours dans un endroit sûr : chacun sert une fois si vous perdez votre téléphone. Ils ne seront plus affichés.'),
        h('pre', { class: 'mono', id: 'recovery-codes', style: { padding: '12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px', userSelect: 'all' } }, reveal.recoveryCodes.join('\n')),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
          h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await navigator.clipboard.writeText(reveal.recoveryCodes.join('\n')); toast('Codes copiés'); }) }, 'Copier'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => load() }, 'J\'ai noté mes codes')));
    }
    if (sec.twofa.enabled) {
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', id: 'twofa-off-pw' });
      const code = h('input', { class: 'input mono', autocomplete: 'one-time-code', id: 'twofa-off-code', maxlength: 12 });
      const off = guard(async (e) => {
        e.preventDefault();
        await api('/account/2fa/disable', { method: 'POST', body: { password: pw.value, code: code.value } });
        toast('Double authentification désactivée');
        load();
      });
      return h('div', {},
        h('p', { style: { marginBottom: '10px' } }, h('span', { class: 'chip ok' }, ic('check'), 'Activée'), ' Un code est demandé à chaque connexion.'),
        h('form', { onsubmit: off },
          h('div', { class: 'row' }, field('Mot de passe', pw), field('Code de vérification ou code de secours', code)),
          h('button', { class: 'btn', type: 'submit' }, 'Désactiver la double authentification')));
    }
    if (reveal.secret) {
      const code = h('input', { class: 'input mono', autocomplete: 'one-time-code', inputmode: 'numeric', id: 'twofa-on-code', maxlength: 7 });
      const on = guard(async (e) => {
        e.preventDefault();
        const r = await api('/account/2fa/enable', { method: 'POST', body: { code: code.value } });
        render(await api('/account/security'), { recoveryCodes: r.recoveryCodes });
      });
      const uri = /^otpauth:\/\//.test(reveal.otpauth) ? reveal.otpauth : null;
      return h('div', {},
        h('p', { style: { marginBottom: '8px' } }, 'Dans votre application d\'authentification (Google Authenticator, Authy, 1Password, Bitwarden…), ajoutez un compte avec cette clé :'),
        h('pre', { class: 'mono', id: 'twofa-secret', style: { padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px', userSelect: 'all', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, reveal.secret),
        uri ? h('p', { class: 'hint', style: { marginBottom: '10px' } }, 'Sur ce téléphone : ', h('a', { href: uri }, 'ouvrir dans mon application d\'authentification')) : null,
        h('form', { onsubmit: on },
          field('Code à 6 chiffres affiché par l\'application', code),
          h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn primary', type: 'submit' }, 'Activer'), h('button', { class: 'btn', type: 'button', onclick: () => load() }, 'Annuler'))));
    }
    return h('div', {},
      h('p', { class: 'muted', style: { marginBottom: '8px' } }, 'Protégez votre compte avec un code à usage unique en plus du mot de passe.'),
      h('button', { class: 'btn', type: 'button', id: 'twofa-begin', onclick: guard(async () => { const r = await api('/account/2fa/begin', { method: 'POST' }); render(sec, { secret: r.secret, otpauth: r.otpauth }); }) }, 'Activer la double authentification'));
  }

  load();
  return card;
}

// ───────────── Connexion ─────────────
// Un fournisseur d'authentification peut enrichir GET /api/auth (voir docs/couche-cloud.md §3.1) :
//   identifierLabel  libellé du premier champ (« Adresse e-mail » au lieu de « Identifiant »)
//   links            { signup, forgot } : adresses (du même site) des pages d'inscription et de mot de passe oublié
// et répondre à POST /api/login par { code: 'needs_2fa' } : l'écran demande alors le code de double authentification.
const localHref = (u) => (typeof u === 'string' && /^\/(?!\/)/.test(u) ? u : null); // chemin du même site seulement : jamais « javascript: » ni un autre domaine

function viewLogin() {
  const label = S.auth.identifierLabel || 'Identifiant';
  const user = h('input', { class: 'input', id: 'login-user', name: 'username', autocomplete: 'username', autocapitalize: 'off', spellcheck: false, 'aria-label': label });
  const pw = h('input', { class: 'input', id: 'login-pw', name: 'password', type: 'password', autocomplete: 'current-password', 'aria-label': 'Mot de passe' });
  const code = h('input', { class: 'input mono', id: 'login-code', name: 'code', autocomplete: 'one-time-code', inputmode: 'text', autocapitalize: 'off', spellcheck: false, 'aria-label': 'Code de vérification', maxlength: 12 });
  const codeField = h('div', { class: 'field', id: 'login-code-field', hidden: true },
    h('label', {}, 'Code de vérification'), code,
    h('span', { class: 'hint' }, 'Les 6 chiffres affichés par votre application d\'authentification, ou un code de secours.'));
  const err = h('p', { role: 'alert', style: { color: 'var(--crit)', margin: '4px 0 12px', minHeight: '20px', fontSize: '13px' } });
  const btn = h('button', { class: 'btn primary', style: { width: '100%' } }, 'Se connecter');
  const submit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { username: user.value, password: pw.value, ...(codeField.hidden ? {} : { code: code.value }) } });
      S.auth.authenticated = true;
      boot();
    } catch (x) {
      if (x.code === 'needs_2fa' || x.code === 'invalid_2fa') {
        codeField.hidden = false;
        code.value = '';
        code.focus();
        err.textContent = x.code === 'invalid_2fa' ? x.message : '';
      } else {
        err.textContent = x.message;
        pw.value = '';
        pw.focus();
      }
    } finally { btn.disabled = false; }
  };
  const links = [[localHref(S.auth.links?.forgot), 'Mot de passe oublié ?'], [localHref(S.auth.links?.signup), 'Créer un compte']].filter(([href]) => href);
  $('#app').replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'logo' }, h('img', { src: '/icon-192.png', alt: '', width: 84, height: 84 })), h('h1', {}, ...brandName()), h('p', { class: 'muted' }, 'Connectez-vous pour accéder à la surveillance.'),
    h('form', { onsubmit: submit },
      h('div', { class: 'field' }, h('label', {}, label), user),
      h('div', { class: 'field' }, h('label', {}, 'Mot de passe'), pw),
      codeField, err, btn),
    links.length ? h('p', { class: 'login-links' }, ...links.map(([href, text]) => h('a', { href }, text))) : null)));
  linkLabels($('#app'));
  user.focus();
}

// ───────────── Démarrage ─────────────
let eventsOn = false;
async function boot() {
  applyTheme();
  try {
    S.auth = await fetch('/api/auth').then((r) => r.json());
  } catch {
    $('#app').replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' }, h('h2', {}, 'Serveur injoignable'), h('p', { class: 'muted' }, 'SuricateWeb ne répond pas. Vérifiez que le serveur est démarré.'))));
    return;
  }
  if (S.auth.required && !S.auth.authenticated) return viewLogin();
  if (!S.settings) S.settings = await api('/settings').catch(() => null);
  S.caps = await fetch('/api/capabilities').then((r) => r.json()).catch(() => ({}));
  mountShell();
  if (!eventsOn) { eventsOn = true; connectEvents(); }
  route();
}
// Application installable : le manifeste est lié dans index.html. Échoue sans bruit hors HTTPS (ou localhost).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
