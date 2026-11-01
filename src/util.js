import { createHash } from 'node:crypto';

export const sha1 = (d) => createHash('sha1').update(d).digest('hex');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Rang de sévérité : sert à filtrer les notifications. */
export const SEV = { info: 1, warning: 2, critical: 3 };

export const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'asso', 'nom']);

/** Domaine enregistrable approximatif (example.co.uk, example.fr…) sans liste publique des suffixes. */
export function registrable(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || isIp(host)) return host;
  const p = host.split('.');
  if (p.length <= 2) return host;
  const tld = p[p.length - 1];
  const sld = p[p.length - 2];
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

export const clamp = (n, min, max, fallback) => {
  // Un paramètre absent (null, undefined, '') n'est PAS un 0 : Number(null) === 0 le ferait borner au minimum.
  n = n === null || n === undefined || n === '' ? NaN : Number(n);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const uniq = (arr) => [...new Set(arr)];

/** 45 s · 12 min · 3 h 05 · 2 j 4 h */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} j ${h % 24} h` : `${d} j`;
}
