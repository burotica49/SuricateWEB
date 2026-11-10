// Générateur de code QR, sans dépendance : texte → matrice de modules (booléens) → chemin SVG.
//
// Pourquoi ici : l'activation de la double authentification se fait en SCANNANT un code QR avec le téléphone ; recopier une clé de 32
// caractères à la main est pénible et source d'erreurs. Le cœur n'a aucune dépendance et pas d'étape de build : ce fichier est donc un
// petit encodeur complet (octets UTF-8, niveau de correction « M », versions 1 à 10, soit jusqu'à 213 octets), suffisant pour une adresse
// otpauth://. Au-delà, `qrMatrix` lève une erreur plutôt que de produire un code illisible.
//
// Étapes (norme ISO/IEC 18004) : données → mots de code → correction d'erreurs Reed-Solomon par blocs → entrelacement → placement en
// zigzag autour des motifs fixes → choix du masque au moindre « pénalité » → bits de format et de version.

const MAX_VERSION = 10;
// Niveau M : mots de correction par bloc et nombre de blocs, pour les versions 1 à 10.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0; // bits de niveau de correction « M » dans l'indicateur de format

const size = (ver) => ver * 4 + 17;

/** Modules de données d'une version (ni motifs fixes, ni format, ni version). */
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

// ───────────── Corps de Galois GF(256) et Reed-Solomon ─────────────
const gfMul = (x, y) => {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
};
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}
function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

// ───────────── Données → mots de code ─────────────
function buildCodewords(bytes) {
  let ver = 1;
  const countBits = (v) => (v < 10 ? 8 : 16);
  while (ver <= MAX_VERSION && 4 + countBits(ver) + 8 * bytes.length > dataCodewords(ver) * 8) ver++;
  if (ver > MAX_VERSION) throw new Error(`Texte trop long pour le code QR (${bytes.length} octets, 213 au plus).`);

  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); // mode « octets »
  put(bytes.length, countBits(ver));
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length)); // terminateur
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // Blocs, correction d'erreurs, entrelacement.
  const blocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const parts = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(chunk, divisor);
    if (i < shortBlocks) chunk.push(0); // alignement des blocs courts pour l'entrelacement
    parts.push(chunk.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    parts.forEach((blk, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(blk[i]); });
  }
  return { ver, codewords: out };
}

// ───────────── Matrice ─────────────
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size(ver) - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const bchRemainder = (value, poly, bitsInRemainder) => {
  let rem = value << bitsInRemainder;
  const top = 31 - Math.clz32(poly);
  for (let i = 31 - Math.clz32(rem || 1); i >= top; i--) if ((rem >>> i) & 1) rem ^= poly << (i - top);
  return rem;
};

/** Matrice de modules d'un texte : { size, modules: boolean[][] (modules[y][x] = sombre) }. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const { ver, codewords } = buildCodewords(bytes);
  const n = size(ver);
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false)); // modules qui ne portent pas de données
  const set = (x, y, dark) => { if (x >= 0 && x < n && y >= 0 && y < n) { m[y][x] = dark; fixed[y][x] = true; } };

  // Lignes de synchronisation.
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Motifs de repérage et leurs séparateurs.
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  // Motifs d'alignement (sauf sur les trois repères).
  const pos = alignmentPositions(ver);
  for (let a = 0; a < pos.length; a++) for (let b = 0; b < pos.length; b++) {
    if ((a === 0 && b === 0) || (a === 0 && b === pos.length - 1) || (a === pos.length - 1 && b === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[a] + dx, pos[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  const drawFormat = (mask) => {
    const data = (FORMAT_M << 3) | mask;
    const bits = ((data << 10) | bchRemainder(data, 0x537, 10)) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
    set(8, n - 8, true); // module sombre fixe
  };
  const drawVersion = () => {
    if (ver < 7) return;
    const bits = (ver << 12) | bchRemainder(ver, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  };
  drawFormat(0); // réserve la place (valeur provisoire) avant de poser les données
  drawVersion();

  // Données : zigzag par colonnes de deux modules, de droite à gauche, en sautant la ligne verticale de synchronisation.
  const bitsOut = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bitsOut.push(((b >>> i) & 1) === 1);
  let k = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert; // sens montant ou descendant selon la colonne
        if (!fixed[y][x] && k < bitsOut.length) m[y][x] = bitsOut[k++];
      }
    }
  }

  // Masque : celui de moindre pénalité.
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (mask) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fixed[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x]; };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(m, n);
    if (score < bestScore) { bestScore = score; best = mask; }
    applyMask(mask); // le masque est son propre inverse
  }
  applyMask(best);
  drawFormat(best);
  return { size: n, modules: m, version: ver, mask: best };
}

/** Pénalité d'un masque (règles 1 à 4 de la norme) : plus elle est basse, plus le code se lit facilement. */
function penalty(m, n) {
  let score = 0;
  const lines = [];
  for (let y = 0; y < n; y++) lines.push(m[y]);
  for (let x = 0; x < n; x++) lines.push(m.map((row) => row[x]));
  for (const line of lines) {
    // Règle 1 : suites de 5 modules identiques ou plus. Règle 3 : motif 1:1:3:1:1 entouré de blanc.
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    const s = line.map((d) => (d ? '1' : '0')).join('');
    for (const pat of ['10111010000', '00001011101']) {
      for (let i = s.indexOf(pat); i !== -1; i = s.indexOf(pat, i + 1)) score += 40;
    }
  }
  // Règle 2 : blocs 2×2 de même couleur.
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  // Règle 4 : équilibre entre modules sombres et clairs.
  let dark = 0;
  for (const row of m) for (const d of row) if (d) dark++;
  const total = n * n;
  score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Chemin SVG (un seul `<path d>`) des modules sombres, dans un repère où chaque module vaut 1 et avec la zone de silence de 4 modules que
 * les lecteurs exigent. `viewBox` = « 0 0 N N » à poser sur l'élément <svg>.
 */
export function qrPath(text, quiet = 4) {
  const { size: n, modules } = qrMatrix(text);
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y][x]) continue;
      let w = 1;
      while (x + w < n && modules[y][x + w]) w++; // une barre par suite horizontale : chemin plus court
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return { d, viewBox: `0 0 ${n + 2 * quiet} ${n + 2 * quiet}`, size: n + 2 * quiet };
}
