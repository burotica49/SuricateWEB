// VigieWeb — interface. SPA sans framework ni étape de build. Tout texte dynamique passe par textContent (pas d'innerHTML sur des données).

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

const avatar = (name) => h('div', { class: 'avatar', style: { background: `hsl(${hue(name)} 52% 46%)` } }, (name.trim()[0] || '?'));

// ───────────── API ─────────────
// view : « groups » (organisation manuelle en groupes) ou « status » (liste à plat, sites en alerte en premier).
const loadView = () => { try { return localStorage.getItem('vigie-view') === 'status' ? 'status' : 'groups'; } catch { return 'groups'; } };
const S = { auth: null, watches: [], groups: [], settings: null, filter: 'all', q: '', tag: null, open: new Set(), alertSev: '', view: loadView(), dragging: false };

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
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
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
  try { t = localStorage.getItem('vigie-theme'); } catch { /* stockage indisponible */ }
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  try { localStorage.setItem('vigie-theme', dark ? 'light' : 'dark'); } catch { /* ignoré */ }
  applyTheme();
  mountShell();
  route();
}
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);

// ───────────── Shell ─────────────
function mountShell() {
  const tgOk = S.settings?.telegram.tokenSet && S.settings?.telegram.chatId;
  const app = S.settings?.app ?? {}; // version et liens (absents tant que les réglages ne sont pas chargés)
  const nav = (href, icon, label, id) => h('a', { href, 'data-nav': id }, ic(icon), h('span', {}, label), id === 'alertes' ? h('span', { class: 'badge', id: 'nav-badge', hidden: true }) : null);
  $('#app').replaceChildren(
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' }, h('div', { class: 'logo' }, ic('shield')),
          h('div', {}, h('div', { class: 'brand-name' }, 'VigieWeb', app.version ? h('span', { class: 'ver', title: `Version ${app.version}` }, `v${app.version}`) : null), h('small', {}, 'Surveillance de sites'))),
        h('nav', { class: 'nav' }, nav('#/', 'dashboard', 'Sites', 'sites'), nav('#/alertes', 'bell', 'Alertes', 'alertes'), nav('#/reglages', 'settings', 'Réglages', 'reglages')),
        h('div', { class: 'side-foot' },
          h('a', { class: 'tg-state', href: '#/reglages' }, h('span', { class: `dot ${tgOk ? 'ok' : ''}` }), tgOk ? 'Telegram actif' : 'Telegram non configuré'),
          h('div', { class: 'side-actions' },
            // Liens externes : nouvel onglet, sans transmettre l'adresse de cette page (noopener, noreferrer)
            app.repoUrl ? h('a', { class: 'btn ghost icon sm ext', href: app.repoUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Dépôt GitHub', 'aria-label': 'Dépôt GitHub (nouvel onglet)' }, ic('github')) : null,
            app.docsUrl ? h('a', { class: 'btn ghost icon sm ext', href: app.docsUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Documentation (README)', 'aria-label': 'Documentation (nouvel onglet)' }, ic('book')) : null,
            h('button', { class: 'btn ghost icon sm', title: 'Changer de thème', 'aria-label': 'Changer de thème', onclick: toggleTheme }, ic(isDark() ? 'sun' : 'moon')),
            S.auth?.required ? h('button', { class: 'btn ghost icon sm', title: 'Se déconnecter', 'aria-label': 'Se déconnecter', onclick: guard(async () => { await api('/logout', { method: 'POST' }); S.auth.authenticated = false; boot(); }) }, ic('logout')) : null))),
      h('main', { class: 'main', id: 'view' })));
  updateNav();
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
addEventListener('hashchange', () => { S.open.clear(); route(); window.scrollTo(0, 0); });

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
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => openSiteForm() }, ic('plus'), 'Ajouter un site'))));

  if (!list.length) {
    const input = h('input', { class: 'input', placeholder: 'https://www.monsite.fr', 'aria-label': 'Adresse du site', onkeydown: (e) => e.key === 'Enter' && go.click() });
    const go = h('button', { class: 'btn primary', onclick: () => openSiteForm(null, input.value) }, ic('plus'), 'Surveiller');
    root.append(empty('shield', 'Aucun site surveillé pour le moment',
      "Ajoutez votre premier site : VigieWeb détecte les défigurations, les scripts injectés, les redirections suspectes, les changements de DNS ou de certificat, et vous prévient sur Telegram.",
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
      try { localStorage.setItem('vigie-view', k); } catch { /* stockage indisponible : la vue ne sera pas mémorisée */ }
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
  if (d != null) chips.push(h('span', { class: `chip ${d < 7 ? 'crit' : d < 30 ? 'warn' : ''}`, title: `Nom de domaine valide jusqu'au ${dday(w.domainExpires)}` }, ic('globe'), d < 0 ? 'expiré' : `${d} j`));
  return chips;
}

/** opts.handle : poignée de glisser-déposer · opts.chip : affiche le groupe (vue « Par état », où les groupes ne sont pas visibles). */
function siteRow(w, opts = {}) {
  const top = w.incidents.find((i) => i.severity === 'critical') || w.incidents[0];
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
    h('div', { class: 'id' }, opts.handle ? handleBtn('site', w.id, `Déplacer « ${w.name} »`) : null, w.shot ? h('img', { class: 'thumb', src: shotUrl(w.shot.id, true), loading: 'lazy', alt: '', title: `Capture ${rel(w.shot.ts)}` }) : avatar(w.name), h('div', { class: 't' },
      h('div', { class: 'name' }, h('span', { class: 'n' }, w.name), statusPill(w), grp ? h('span', { class: 'gchip', style: `--gc:${grp.color}`, title: `Groupe « ${grp.name} »` }, h('span', { class: 'grp-dot' }), grp.name) : null),
      top ? h('div', { class: `issue ${top.severity === 'warning' ? 'warn' : ''}` }, top.title) : h('div', { class: 'url' }, host(w.url) + (w.tags.length ? '  ·  ' + w.tags.join(', ') : '')))),
    h('div', { class: 'sigs' }, ...signalChips(w)),
    h('div', { class: 'spark-col' }, w.mode === 'domain' ? h('div', { class: 'spark-empty' }, 'DNS + registre') : spark(w.spark)),
    w.mode === 'domain'
      ? h('div', { class: 'metric col-metric' }, h('b', {}, 'Domaine seul'), h('span', {}, 'sans site web'))
      : h('div', { class: 'metric col-metric', title: `Disponibilité sur 30 jours${w.avgMs ? ` · réponse moyenne ${fmtMs(w.avgMs)}` : ''}` }, h('b', {}, pct(w.uptime30)), h('span', {}, '30 derniers jours')),
    h('div', { class: 'metric col-when' }, h('b', {}, w.lastCheck ? rel(w.lastCheck) : 'jamais'), h('span', {}, w.enabled ? `toutes les ${w.interval < 60 ? w.interval + ' min' : w.interval / 60 + ' h'}` : 'en pause')),
    checkBtn);
}

// ───────────── Détail d'un site ─────────────
async function viewDetail(id, tab, tok, openSnap) {
  // Les groupes alimentent le champ « Groupe » du formulaire de modification, même si on arrive directement sur cette page.
  const [w, groups] = await Promise.all([api(`/watches/${id}`), api('/groups')]);
  S.groups = groups;
  S.cur = w;
  const root = h('div', {});
  const unread = w.unread.critical + w.unread.warning + w.unread.info;

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
        h('h1', {}, w.name, statusPill(w)),
        h('div', { class: 'url' }, h('a', { href: w.url, target: '_blank', rel: 'noopener noreferrer' }, w.url, ' ', ic('external')), w.tags.length ? '  ·  ' + w.tags.join(', ') : ''))),
      h('div', { class: 'actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        unread ? h('button', { class: 'btn', onclick: guard(async () => { await api(`/watches/${id}/ack`, { method: 'POST' }); toast('Marqué comme vérifié'); route(); }) }, ic('check'), 'Tout est normal') : null,
        h('button', { class: 'btn', onclick: doCheck }, ic('refresh'), 'Vérifier maintenant'),
        h('button', { class: 'btn', onclick: guard(async () => { await api(`/watches/${id}/toggle`, { method: 'POST' }); toast(w.enabled ? 'Surveillance mise en pause' : 'Surveillance reprise'); route(); }) }, ic(w.enabled ? 'pause' : 'play'), w.enabled ? 'Pause' : 'Reprendre'),
        h('button', { class: 'btn', onclick: () => openSiteForm(w) }, ic('edit'), 'Modifier'),
        h('button', { class: 'btn icon danger', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: guard(async () => {
          if (!(await confirmDialog({ title: `Supprimer « ${w.name} » ?`, text: "L'historique, les versions enregistrées et les alertes de ce site seront définitivement effacés.", confirm: 'Supprimer', danger: true }))) return;
          await api(`/watches/${id}`, { method: 'DELETE' });
          toast('Site supprimé');
          location.hash = '#/';
        }) }, ic('trash')))));

  for (const i of w.incidents) {
    root.append(h('div', { class: `incident ${i.severity === 'warning' ? 'warn' : ''}` }, ic('alert'),
      h('div', {}, h('b', {}, i.title), i.detail ? h('p', {}, i.detail) : null, h('small', {}, `Depuis ${rel(i.since)}`))));
  }

  const domainOnly = w.mode === 'domain';
  const tabs = domainOnly
    ? [['apercu', 'Aperçu', 'activity'], ['domaine', 'Domaine & DNS', 'globe'], ['alertes', 'Alertes', 'bell']]
    : [['apercu', 'Aperçu', 'activity'], ['captures', 'Captures', 'image'], ['disponibilite', 'Disponibilité', 'clock'], ['modifications', 'Modifications', 'file'], ['domaine', 'Domaine & DNS', 'globe'], ['alertes', 'Alertes', 'bell']];
  root.append(h('div', { class: 'tabs', role: 'tablist' }, ...tabs.map(([k, l, icn]) => h('a', { href: `#/sites/${id}/${k}`, class: tab === k ? 'on' : '', role: 'tab' }, ic(icn), l,
    k === 'alertes' && unread ? h('span', { class: 'badge' }, unread) : null))));

  if (tab === 'modifications' && !domainOnly) root.append(await changesTab(w, openSnap));
  else if (tab === 'captures' && !domainOnly) root.append(await capturesTab(w));
  else if (tab === 'disponibilite' && !domainOnly) root.append(await uptimeTab(w));
  else if (tab === 'domaine') root.append(await domainTab(w));
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
    root.append(h('div', { class: 'callout' }, ic('globe'), h('div', {}, h('b', {}, 'Surveillance du domaine seul. '), 'Aucune requête n\'est envoyée à un site web : VigieWeb suit les enregistrements DNS et la fiche du domaine au registre (transfert, registrar, serveurs de noms, verrou, DNSSEC, expiration).'),
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
  return root;
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
const shotUrl = (id, thumb) => `/api/screenshots/${id}/image${thumb ? '?thumb=1' : ''}`;
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
  const on = w.config.screenshot.enabled;
  const s = w.shot;
  const body = s
    ? h('button', { class: 'pv-img', title: 'Agrandir', 'aria-label': 'Agrandir la capture', onclick: guard(async () => {
      const d = await api(`/watches/${w.id}/screenshots`);
      openLightbox(d.items, Math.max(0, d.items.findIndex((x) => x.id === s.id)), w);
    }) }, h('img', { src: shotUrl(s.id), alt: `Capture de ${w.name}` }))
    : h('div', { class: 'pv-empty' }, ic('image'),
      h('b', {}, !avail ? 'Navigateur introuvable' : !on ? 'Captures désactivées' : w.shotError ? 'Capture impossible' : 'Première capture en cours…'),
      h('span', {}, !avail ? 'Installez Chrome ou Chromium sur le serveur, ou définissez CHROME_PATH.' : !on ? 'Activez-les dans « Modifier › Capture d\'écran ».' : w.shotError || 'Elle apparaît dans quelques secondes.'));
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
  if (!d.available) {
    root.append(h('div', { class: 'callout' }, ic('info'), h('div', {}, h('b', {}, 'Aucun navigateur sur le serveur. '), 'Les captures d\'écran nécessitent Chrome ou Chromium. Installez-le, ou indiquez son chemin dans la variable CHROME_PATH (déjà inclus dans l\'image Docker).')));
  } else {
    root.append(h('div', { class: 'card', style: { padding: '14px 18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' } },
      h('div', { style: { flex: 1, minWidth: '220px' } },
        h('b', {}, d.enabled ? `Une capture toutes les ${everyLabel(d.interval)}` : 'Captures désactivées pour ce site'),
        h('div', { class: 'muted', style: { fontSize: '13px' } }, d.enabled ? (d.capturing ? 'Capture en cours…' : `Prochaine ${rel(d.nextShot)} · ${w.config.screenshot.width}×${w.config.screenshot.height}${w.config.screenshot.fullPage ? ', page entière' : ''}`) : 'Activez-les dans « Modifier › Capture d\'écran ».')),
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
      h('img', { src: shotUrl(it.id, true), loading: 'lazy', alt: '' }),
      h('div', { class: 'shot-meta' }, h('b', {}, dt(it.ts)), cls ? h('span', { class: `pill ${cls}` }, label) : h('span', { class: 'muted' }, rel(it.ts))));
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
  const fig = (label, it) => h('figure', {}, label ? h('figcaption', {}, h('b', {}, label), ` · ${dt(it.ts)}`) : null, h('img', { src: shotUrl(it.id), alt: `Capture du ${dt(it.ts)}` }));
  const go = (n) => { if (n >= 0 && n < items.length) { i = n; render(); } };
  function render() {
    const cur = items[i];
    const prev = items[i + 1];
    const [label, cls] = SHOT_KIND[cur.kind] || SHOT_KIND.scheduled;
    title.replaceChildren(h('b', {}, w.name), h('span', {}, `${dt(cur.ts)} · ${rel(cur.ts)}`), cls ? h('span', { class: `pill ${cls}` }, label) : null, h('span', { class: 'muted' }, `${i + 1} / ${items.length}`));
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
      h('a', { class: 'btn sm', href: shotUrl(items[start].id), target: '_blank', rel: 'noopener' }, ic('external'), 'Original'),
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
          a.notified ? h('span', { class: 'chip ok' }, ic('send'), 'Envoyé sur Telegram') : a.notifyError ? h('span', { class: 'chip crit', title: a.notifyError }, ic('alert'), 'Échec Telegram') : null))));
  }
  return box;
}

async function viewAlerts() {
  const q = S.alertSev ? `&severity=${S.alertSev}` : '';
  const [alerts, list] = await Promise.all([api(`/alerts?limit=100${q}`), api('/watches')]);
  S.watches = list;
  const root = h('div', {});
  const unread = alerts.filter((a) => !a.read).length;
  root.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Alertes'), h('p', {}, 'Tout ce que VigieWeb a détecté, du plus récent au plus ancien.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: !list.some((w) => w.unread.critical + w.unread.warning + w.unread.info), onclick: guard(async () => { await api('/alerts/read', { method: 'POST', body: { all: true } }); toast('Toutes les alertes sont marquées comme lues'); route(); }) }, ic('check'), 'Tout marquer comme lu'))));
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
  };
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

  const body = h('form', { class: mode === 'domain' ? 'domain-mode' : '', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'field' }, h('label', {}, 'Type de surveillance'), modeSeg, modeHint),
    h('div', { class: 'field' }, h('label', {}, 'Adresse du site ou domaine'), h('div', { class: 'input-group' }, f.url, siteOnly(testBtn)), siteOnly(testOut)),
    h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Nom'), f.name), h('div', { class: 'field' }, h('label', {}, 'Fréquence de contrôle'), f.interval)),
    h('div', { class: 'field' }, h('label', {}, 'Groupe'), f.group, h('span', { class: 'hint' }, 'Pour classer vos sites dans la liste (par client, par projet…). Vous pouvez aussi les glisser-déposer.')),
    h('div', { class: 'field' }, h('label', {}, 'Étiquettes'), f.tags, h('span', { class: 'hint' }, 'Séparées par des virgules — pratique pour regrouper par client.')),
    h('h3', { style: { margin: '22px 0 4px' } }, 'Que surveiller ?'), h('p', { class: 'muted', style: { marginBottom: '8px' } }, 'La configuration recommandée surveille tout. Désactivez ce qui produit trop de bruit sur ce site.'),
    ...groups,
    siteOnly(details('Capture d\'écran', [
      S.settings?.screenshots?.available === false
        ? h('div', { class: 'callout', style: { marginBottom: '12px' } }, ic('info'), h('div', {}, 'Aucun navigateur détecté sur le serveur : les captures sont inactives. Installez Chrome ou Chromium, ou définissez CHROME_PATH.')) : null,
      toggle(f.shotOn, 'Capturer le site régulièrement', 'Un aperçu visuel à jour, et l\'historique des changements d\'apparence.'),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('div', { class: 'field' }, h('label', {}, 'Fréquence'), f.shotEvery),
        h('div', { class: 'field' }, h('label', {}, 'Format de la fenêtre'), f.shotSize)),
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
          screenshot: { enabled: f.shotOn.checked, interval: Number(f.shotEvery.value), fullPage: f.shotFull.checked, width: Number(f.shotSize.value.split('x')[0]), height: Number(f.shotSize.value.split('x')[1]), delay: Number(f.shotDelay.value), interact: f.shotInteract.checked, hideBanners: f.shotBanners.checked },
          checks: Object.fromEntries(Object.entries(checks).map(([k, el]) => [k, el.checked])),
          selector: f.selector.value, excludeSelector: f.exclude.value, ignoreRegex: list(f.ignore), images: f.images.checked,
          forbidden: list(f.forbidden), required: list(f.required), userAgent: f.ua.value, timeoutS: Number(f.timeout.value), failThreshold: Number(f.fails.value),
          minChangePct: Number(f.minPct.value), allowedHosts: list(f.allowed, /[,\n]/), headers, notify: f.notify.checked, minSeverity: f.minSev.value,
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
    minSev: h('select', { class: 'input', value: t.minSeverity }, h('option', { value: 'info' }, 'Tout, y compris les infos'), h('option', { value: 'warning' }, 'Attention et critique (recommandé)'), h('option', { value: 'critical' }, 'Critique uniquement')),
    base: h('input', { class: 'input', placeholder: 'http://monserveur:3000 (pour les liens dans les messages)', value: s.baseUrl }),
    interval: h('select', { class: 'input', value: String(s.defaultInterval) }, ...INTERVALS.map(([v, l]) => h('option', { value: String(v) }, l))),
    ua: h('input', { class: 'input', value: s.userAgent }),
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
      telegram: { token: f.token.value.trim(), chatId: f.chat.value.trim(), enabled: f.enabled.checked, sendRecovery: f.recovery.checked, includeDiff: f.diff.checked, sendScreenshot: f.photo.checked, minSeverity: f.minSev.value },
      baseUrl: f.base.value, defaultInterval: Number(f.interval.value), userAgent: f.ua.value, builtinKeywords: f.kw.value.split('\n'),
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
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Réglages'), h('p', {}, 'Notifications, détection et sécurité de VigieWeb.')), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: save }, ic('check'), 'Enregistrer'))),
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
        h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', {}, 'Niveau minimal des notifications'), f.minSev),
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Adresse de VigieWeb (optionnel)'), f.base, h('span', { class: 'hint' }, 'Ajoute un lien « Ouvrir dans VigieWeb » à chaque message.'))),
      h('section', { class: 'card card-pad' },
        h('h2', { style: { marginBottom: '14px' } }, 'Détection'),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Fréquence par défaut'), f.interval), h('div', { class: 'field' }, h('label', {}, 'User-Agent par défaut'), f.ua)),
        h('div', { class: 'toggle-row', style: { borderTop: 0, paddingTop: 0, marginBottom: '14px' } }, h('div', { class: 'tt' }, h('b', {}, 'Navigateur pour les captures d\'écran'),
          h('span', {}, s.screenshots.available ? s.screenshots.browser : 'Aucun Chrome / Chromium détecté : installez-en un ou définissez CHROME_PATH.')),
          h('span', { class: `chip ${s.screenshots.available ? 'ok' : 'warn'}` }, ic(s.screenshots.available ? 'check' : 'alert'), s.screenshots.available ? 'Détecté' : 'Introuvable')),
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Liste intégrée de mots-clés suspects'), f.kw,
          h('span', { class: 'hint' }, 'Un par ligne. Détectés dans le texte de chaque page : revendications de pirates, pages par défaut de serveur, domaine à vendre, spam.'),
          h('div', {}, h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: () => { f.kw.value = s.defaultKeywords.join('\n'); } }, 'Rétablir la liste par défaut')))),
      h('section', { class: 'card card-pad' },
        h('h2', { style: { marginBottom: '4px' } }, 'Sécurité'),
        h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'L\'accès à VigieWeb est protégé par un identifiant et un mot de passe définis hors de l\'application.'),
        h('div', { class: 'toggle-row' }, h('div', { class: 'tt' }, h('b', {}, 'Identifiant de connexion'), h('span', {}, 'Variable VIGIE_USER')), h('span', { class: 'chip' }, ic('lock'), s.authUser)),
        h('p', { class: 'hint muted', style: { marginTop: '12px' } }, 'Pour changer l\'identifiant ou le mot de passe, modifiez VIGIE_USER et VIGIE_PASSWORD dans le fichier .env (ou dans les variables d\'environnement de votre hébergement), puis redémarrez VigieWeb. Toutes les sessions ouvertes seront alors déconnectées.')),
      h('section', { class: 'card card-pad' },
        h('h2', { style: { marginBottom: '4px' } }, 'Données'),
        h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Exportez la liste de vos sites et leur configuration, ou importez-en une.'),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('a', { class: 'btn', href: '/api/export', download: 'vigie-sites.json' }, ic('download'), 'Exporter'),
          h('button', { class: 'btn', onclick: () => importInput.click() }, ic('upload'), 'Importer'), importInput))));
}

// ───────────── Connexion ─────────────
function viewLogin() {
  const user = h('input', { class: 'input', id: 'login-user', name: 'username', autocomplete: 'username', autocapitalize: 'off', spellcheck: false, 'aria-label': 'Identifiant' });
  const pw = h('input', { class: 'input', id: 'login-pw', name: 'password', type: 'password', autocomplete: 'current-password', 'aria-label': 'Mot de passe' });
  const err = h('p', { role: 'alert', style: { color: 'var(--crit)', margin: '4px 0 12px', minHeight: '20px', fontSize: '13px' } });
  const btn = h('button', { class: 'btn primary', style: { width: '100%' } }, 'Se connecter');
  const submit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { username: user.value, password: pw.value } });
      S.auth.authenticated = true;
      boot();
    } catch (x) {
      err.textContent = x.message;
      pw.value = '';
      pw.focus();
    } finally { btn.disabled = false; }
  };
  $('#app').replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'logo' }, ic('shield')), h('h1', {}, 'VigieWeb'), h('p', { class: 'muted' }, 'Connectez-vous pour accéder à la surveillance.'),
    h('form', { onsubmit: submit },
      h('div', { class: 'field' }, h('label', {}, 'Identifiant'), user),
      h('div', { class: 'field' }, h('label', {}, 'Mot de passe'), pw),
      err, btn))));
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
    $('#app').replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' }, h('h2', {}, 'Serveur injoignable'), h('p', { class: 'muted' }, 'VigieWeb ne répond pas. Vérifiez que le serveur est démarré.'))));
    return;
  }
  if (S.auth.required && !S.auth.authenticated) return viewLogin();
  if (!S.settings) S.settings = await api('/settings').catch(() => null);
  mountShell();
  if (!eventsOn) { eventsOn = true; connectEvents(); }
  route();
}
boot();
