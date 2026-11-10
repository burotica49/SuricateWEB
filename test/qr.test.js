// Générateur de code QR (public/qr.js) : structure conforme à la norme, valeur de référence, limites. Le DÉCODAGE réel (17 textes, versions
// 1 à 10, accents compris) a été vérifié avec le détecteur QR de macOS (CoreImage) au moment de l'écriture ; la valeur de référence ci-dessous
// protège ce résultat contre toute régression involontaire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qrMatrix, qrPath } from '../public/qr.js';

const URI = 'otpauth://totp/SuricateWeb:marie@exemple.fr?secret=JBSWY3DPEHPK3PXP&issuer=SuricateWeb';
const hashOf = (q) => createHash('sha256').update(q.modules.map((r) => r.map((d) => (d ? '1' : '0')).join('')).join('\n')).digest('hex');

test('référence : l\'adresse otpauth d\'exemple donne toujours la même matrice (version 6, 41 × 41)', () => {
  const q = qrMatrix(URI);
  assert.deepEqual([q.version, q.size], [6, 41]);
  assert.equal(hashOf(q), '4d7d084bb8b62a7d458613cb2162416ff6458390ce41a7295e5dd876abc5b4dd');
  assert.equal(hashOf(qrMatrix(URI)), hashOf(q), 'déterministe');
});

test('structure : repères, synchronisation, module sombre, bits de format valides (deux copies identiques)', () => {
  for (const text of [URI, 'A', 'x'.repeat(122), 'é à ü — 日本語']) {
    const { size: n, modules: m, version } = qrMatrix(text);
    assert.equal(n, version * 4 + 17);
    // Trois repères 7×7 : anneau sombre, anneau clair, centre 3×3 sombre ; séparateurs clairs.
    for (const [cx, cy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(m[cy + dy][cx + dx], d !== 2, `repère en (${cx},${cy}) module (${dx},${dy})`);
      }
    }
    for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0, 'synchronisation horizontale'); assert.equal(m[i][6], i % 2 === 0, 'synchronisation verticale'); }
    assert.equal(m[n - 8][8], true, 'module sombre fixe');

    // Format : 15 bits, deux copies, BCH(15,5) valide une fois le masque 0x5412 retiré.
    const copyA = []; for (let i = 0; i <= 5; i++) copyA.push(m[i][8]); copyA.push(m[7][8], m[8][8], m[8][7]); for (let i = 9; i < 15; i++) copyA.push(m[8][14 - i]);
    const copyB = []; for (let i = 0; i < 8; i++) copyB.push(m[8][n - 1 - i]); for (let i = 8; i < 15; i++) copyB.push(m[n - 15 + i][8]);
    assert.deepEqual(copyA, copyB, 'les deux copies du format concordent');
    const bits = copyA.reduce((acc, b, i) => acc | ((b ? 1 : 0) << i), 0) ^ 0x5412;
    let rem = bits; for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    assert.equal(rem, 0, 'bits de format : code BCH valide');
    assert.equal((bits >>> 13) & 3, 0, 'niveau de correction « M »');
  }
});

test('versions 1 à 10 : la plus petite qui convient, et une erreur claire au-delà de 213 octets', () => {
  const versionFor = (len) => qrMatrix('x'.repeat(len)).version;
  assert.deepEqual([versionFor(1), versionFor(14), versionFor(15), versionFor(26), versionFor(122), versionFor(123), versionFor(213)], [1, 1, 2, 2, 7, 8, 10]);
  assert.throws(() => qrMatrix('x'.repeat(214)), /trop long/);
  // Les caractères accentués comptent en octets UTF-8 (2 à 4), pas en caractères.
  assert.equal(qrMatrix('é'.repeat(8)).version, 2, '16 octets');
});

test('chemin SVG : zone de silence de 4 modules, un seul tracé, viewBox cohérent', () => {
  const { d, viewBox, size } = qrPath(URI);
  assert.equal(size, 41 + 8);
  assert.equal(viewBox, '0 0 49 49');
  assert.match(d, /^M\d+ \d+h\d+v1h-\d+z/);
  assert.ok(!/[^MhvzM\d \-]/.test(d), 'rien d\'autre que des commandes de chemin');
  assert.ok(d.length > 500 && d.length < 12000);
  // Aucun trait ne sort de la zone dessinable.
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1/g)) assert.ok(+x >= 4 && +y >= 4 && +x + +w <= 45 && +y < 45);
});
