// Chiffrement au repos des secrets des réglages (jeton Telegram) : point d'extension `secrets` de configureStore.
// Chaque scénario tourne dans un processus neuf : configureStore doit précéder le premier import de src/db.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGISTRY = new URL('../src/store/registry.js', import.meta.url).href;
const DB = new URL('../src/db.js', import.meta.url).href;

/** Codec de test : « chiffre » en inversant et encodant ; une clé différente donne un résultat illisible (open lève). */
const CODEC = (key) => `{
  seal: (t) => 'v1:' + Buffer.from(${JSON.stringify(key)} + '|' + t).toString('base64url'),
  open: (s) => { const [k, ...r] = Buffer.from(s.slice(3), 'base64url').toString().split('|'); if (k !== ${JSON.stringify(key)}) throw new Error('mauvaise clé'); return r.join('|'); },
}`;

function run(dataDir, body, { key = 'cle-A', codec = true } = {}) {
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    `const { configureStore } = await import(${JSON.stringify(REGISTRY)});
     ${codec ? `configureStore({ secrets: ${CODEC(key)} });` : ''}
     const dbm = await import(${JSON.stringify(DB)});
     const raw = async (k) => JSON.parse((await dbm.db.get('SELECT value FROM settings WHERE key = ?', [k])).value);
     const out = await (async () => { ${body} })();
     console.log('@@' + JSON.stringify(out)); process.exit(0);`,
  ], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
  return JSON.parse(out.split('@@').pop());
}
const dir = () => mkdtempSync(join(tmpdir(), 'suricate-secrets-'));

test('avec un codec : le jeton est chiffré en base, en clair en mémoire et dans la vue des réglages', () => {
  const d = dir();
  const r = run(d, `
    await dbm.saveAccountSettings(5, { telegram: { token: '123456:ABC-secret', chatId: '42' } });
    const stored = await raw('account:5');
    const s = await dbm.settingsFor(5);
    return { stored: stored.telegram, mem: s.telegram.token };`);
  assert.match(r.stored.token, /^v1:/);
  assert.ok(!r.stored.token.includes('ABC-secret') && !JSON.stringify(r.stored).includes('123456:ABC'));
  assert.equal(r.stored.chatId, '42', 'les autres champs restent lisibles');
  assert.equal(r.mem, '123456:ABC-secret');
  // Relecture dans un NOUVEAU processus (cache vide) : déchiffré à la lecture.
  assert.equal(run(d, `return (await dbm.settingsFor(5)).telegram.token;`), '123456:ABC-secret');
});

test('sans codec (installation personnelle) : rien ne change, le jeton reste en clair', () => {
  const r = run(dir(), `
    await dbm.saveAccountSettings(5, { telegram: { token: '999:CLAIR', chatId: '1' } });
    return (await raw('account:5')).telegram.token;`, { codec: false });
  assert.equal(r, '999:CLAIR');
});

test('données d\'avant le chiffrement : lisibles telles quelles, chiffrées par sealStoredSecrets, sans toucher aux autres lignes', () => {
  const d = dir();
  // 1) sans codec : un jeton en clair est enregistré.
  run(d, `await dbm.saveAccountSettings(7, { telegram: { token: '777:ANCIEN', chatId: '7' } }); await dbm.saveAccountSettings(8, { defaultInterval: 30 }); return 1;`, { codec: false });
  // 2) avec codec : lisible, puis chiffré par sealStoredSecrets (une seule ligne concernée).
  const r = run(d, `
    const readable = (await dbm.settingsFor(7)).telegram.token;
    const n = await dbm.sealStoredSecrets();
    const again = await dbm.sealStoredSecrets();
    return { readable, n, again, stored: (await raw('account:7')).telegram.token, other: (await raw('account:8')).telegram.token };`);
  assert.equal(r.readable, '777:ANCIEN');
  assert.deepEqual([r.n, r.again], [1, 0], 'une ligne chiffrée, puis plus rien à faire');
  assert.match(r.stored, /^v1:/);
  assert.equal(r.other, '', 'un compte sans jeton n\'est pas touché');
});

test('clé changée ou perdue : le jeton est considéré absent (à ressaisir) sans faire tomber le service', () => {
  const d = dir();
  run(d, `await dbm.saveAccountSettings(5, { telegram: { token: '123:SECRET', chatId: '1' } }); return 1;`, { key: 'cle-A' });
  const r = run(d, `const s = await dbm.settingsFor(5); return { token: s.telegram.token, chat: s.telegram.chatId };`, { key: 'cle-B' });
  assert.deepEqual(r, { token: '', chat: '1' });
});

test('jeton chiffré mais aucune clé configurée : erreur explicite plutôt que de l\'utiliser tel quel', () => {
  const d = dir();
  run(d, `await dbm.saveAccountSettings(5, { telegram: { token: '123:SECRET', chatId: '1' } }); return 1;`);
  assert.throws(() => run(d, `return (await dbm.settingsFor(5)).telegram.token;`, { codec: false }), /aucune clé n'est configurée/);
});

test('configureStore refuse un codec incomplet', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { configureStore } = await import(${JSON.stringify(REGISTRY)}); try { configureStore({ secrets: { seal() {} } }); console.log('accepté'); } catch (e) { console.log(e.message); }`], { encoding: 'utf8' });
  assert.match(out, /seal\(\) et open\(\)/);
});
