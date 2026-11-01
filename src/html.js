// Parseur HTML tolérant + sélecteurs CSS (sous-ensemble) + extraction de signaux de sécurité.
// Volontairement sans dépendance.
import { registrable } from './util.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'iframe',
]);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', euro: '€', hellip: '…',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', icirc: 'î',
  iuml: 'ï', ucirc: 'û', ugrave: 'ù', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç', deg: '°', times: '×',
};

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      } catch {
        return m;
      }
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const rawCloseCache = {};

export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  let cur = root;
  let i = 0;
  const n = html.length;
  const addText = (s) => s && cur.children.push({ text: s, parent: cur });

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    const next = html[lt + 1] || '';
    if (next === '!' || next === '?') {
      const e = html.indexOf('>', lt + 2);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (next === '/') {
      const e = html.indexOf('>', lt + 2);
      if (e === -1) break;
      const name = html.slice(lt + 2, e).trim().split(/\s/)[0].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      cur = stack[stack.length - 1];
      i = e + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      addText('<');
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let q = null;
    while (j < n) {
      const c = html[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      j++;
    }
    const raw = html.slice(lt + 1, j);
    i = j + 1;
    const m = /^([a-zA-Z][^\s/>]*)/.exec(raw);
    const tag = m[1].toLowerCase();
    const el = { tag, attrs: parseAttrs(raw.slice(m[0].length)), children: [], parent: cur };
    cur.children.push(el);
    if (VOID.has(tag) || /\/\s*$/.test(raw)) continue;
    if (RAW.has(tag)) {
      const re = (rawCloseCache[tag] ??= new RegExp(`</${tag}[\\s>]`, 'gi'));
      re.lastIndex = i;
      const mm = re.exec(html);
      el.children.push({ text: html.slice(i, mm ? mm.index : n), parent: el });
      if (mm) {
        const e = html.indexOf('>', mm.index);
        i = e === -1 ? n : e + 1;
      } else i = n;
      continue;
    }
    stack.push(el);
    cur = el;
  }
  return root;
}

function* walkElements(node) {
  for (const c of node.children || []) {
    if (c.tag) {
      yield c;
      yield* walkElements(c);
    }
  }
}

export const findFirst = (root, tag) => {
  for (const el of walkElements(root)) if (el.tag === tag) return el;
  return null;
};

const rawText = (el) => (el.children || []).map((c) => c.text ?? rawText(c)).join('');

// ───────────── Sélecteurs CSS (tag, #id, .classe, [attr], [attr=val], descendant, >, listes ,) ─────────────

function parseCompound(s) {
  const m = /^([a-zA-Z0-9*_-]+)?((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(s);
  if (!m) throw new Error(`Sélecteur CSS non pris en charge : « ${s} »`);
  const c = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
  const re = /#([\w-]+)|\.([\w-]+)|\[([^\]=~^$*|]+)(?:([~^$*|]?=)["']?([^\]"']*)["']?)?\]/g;
  let t;
  while ((t = re.exec(m[2]))) {
    if (t[1]) c.id = t[1];
    else if (t[2]) c.classes.push(t[2]);
    else c.attrs.push({ name: t[3].trim().toLowerCase(), op: t[4] || null, value: t[5] ?? '' });
  }
  return c;
}

function parseSelector(sel) {
  return sel
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const chain = [];
      const re = /\s*([>])?\s*([^\s>]+)/g;
      let m;
      let first = true;
      while ((m = re.exec(part))) {
        chain.push({ comb: first ? null : m[1] ? '>' : ' ', c: parseCompound(m[2]) });
        first = false;
      }
      if (!chain.length) throw new Error('Sélecteur CSS vide');
      return chain;
    });
}

function matchCompound(el, c) {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const have = (el.attrs.class || '').split(/\s+/);
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
  }
  return true;
}

function matchChain(el, chain, idx) {
  if (!matchCompound(el, chain[idx].c)) return false;
  if (idx === 0) return true;
  const comb = chain[idx].comb;
  if (comb === '>') return !!el.parent && el.parent.tag !== '#root' && matchChain(el.parent, chain, idx - 1);
  for (let p = el.parent; p && p.tag !== '#root'; p = p.parent) if (matchChain(p, chain, idx - 1)) return true;
  return false;
}

export function selectAll(root, selector) {
  const groups = parseSelector(selector);
  const out = [];
  for (const el of walkElements(root)) if (groups.some((chain) => matchChain(el, chain, chain.length - 1))) out.push(el);
  return out;
}

// ───────────── Extraction de texte ─────────────

export function textLines(nodes, { exclude = null, images = false } = {}) {
  const out = [];
  const walk = (node) => {
    if (node.text !== undefined) {
      out.push(node.text);
      return;
    }
    if (SKIP_TEXT.has(node.tag) || (exclude && exclude.has(node))) return;
    const block = BLOCK.has(node.tag);
    if (block || node.tag === 'br') out.push('\n');
    if (images && node.tag === 'img' && node.attrs.src) out.push(`\n[image] ${node.attrs.src.split('?')[0]}\n`);
    for (const c of node.children) walk(c);
    if (block) out.push('\n');
  };
  for (const n of nodes) walk(n);
  return decodeEntities(out.join(''))
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ───────────── Signaux de sécurité ─────────────

const SUSPICIOUS_JS = [
  /eval\s*\(\s*(?:atob|unescape|String\.fromCharCode)/i,
  /document\.write\s*\(\s*(?:unescape|atob|String\.fromCharCode)/i,
  /String\.fromCharCode\s*\((?:\s*\d+\s*,){8,}/i,
  /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){20,}/i,
  /(?:window|document|top)\.location(?:\.href)?\s*=\s*["']https?:\/\/(?!localhost)/i,
  /atob\s*\(\s*["'][A-Za-z0-9+/=]{120,}["']/,
  /\bfunction\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/, // packer
];

function hostOf(u, base) {
  try {
    const x = new URL(u, base);
    return /^https?:$/.test(x.protocol) ? x.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const withoutQuery = (u, base) => {
  try {
    const x = new URL(u, base);
    return x.origin + x.pathname;
  } catch {
    return null;
  }
};

export function extractFeatures(root, pageUrl) {
  const pageHost = hostOf(pageUrl, pageUrl) || '';
  const pageReg = registrable(pageHost);
  const external = (h) => h && registrable(h) !== pageReg;

  const titleEl = findFirst(root, 'title');
  const f = {
    title: titleEl ? decodeEntities(rawText(titleEl)).replace(/\s+/g, ' ').trim() : '',
    scripts: [], suspects: [], linkHosts: [], iframeHosts: [], formHosts: [], metaRefresh: '',
  };
  const links = new Set();
  const iframes = new Set();
  const forms = new Set();
  const scripts = new Set();

  for (const el of walkElements(root)) {
    const a = el.attrs;
    switch (el.tag) {
      case 'script':
        if (a.src) {
          const u = withoutQuery(a.src, pageUrl);
          if (u) scripts.add(u);
        } else {
          const code = rawText(el);
          if (code.length > 20 && SUSPICIOUS_JS.some((r) => r.test(code))) f.suspects.push(code.trim().slice(0, 140).replace(/\s+/g, ' '));
        }
        break;
      case 'a': {
        const h = hostOf(a.href || '', pageUrl);
        if (external(h)) links.add(h);
        break;
      }
      case 'iframe': {
        const h = hostOf(a.src || '', pageUrl);
        if (external(h)) iframes.add(h);
        break;
      }
      case 'form': {
        const h = hostOf(a.action || '', pageUrl);
        if (external(h)) forms.add(h);
        break;
      }
      case 'meta':
        if ((a['http-equiv'] || '').toLowerCase() === 'refresh') f.metaRefresh = a.content || '';
        break;
    }
  }
  f.scripts = [...scripts].sort().slice(0, 400);
  f.linkHosts = [...links].sort().slice(0, 400);
  f.iframeHosts = [...iframes].sort();
  f.formHosts = [...forms].sort();
  f.suspects = [...new Set(f.suspects)].slice(0, 10);
  return f;
}
