// Option de route « raw » : le gestionnaire reçoit les octets EXACTS du corps (ctx.rawBody), sans analyse.
// C'est ce qu'exige la vérification de signature d'un webhook (Stripe…) : la signature porte sur les octets reçus, et
// JSON.parse puis JSON.stringify ne les restitue pas (espaces, ordre des clés, échappements).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-raw-'));
process.env.CHROME_PATH = '/nonexistent/chrome';

const dbm = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { HttpError } = await import('../src/http.js');

const SECRET = 'whsec_test';
const sign = (bytes) => createHmac('sha256', SECRET).update(bytes).digest('hex');
const USERS = { alice: { user: { id: 1, name: 'alice' }, account: { id: 10 } } };

const routes = [({ route }) => {
  // Webhook type Stripe : public (pas de session), authentifié par la signature du corps brut.
  route('POST', '/api/hook', (ctx) => {
    const given = String(ctx.req.headers['x-signature'] || '').replace(/^sha256=/, '');
    const expected = sign(ctx.rawBody);
    const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) throw new HttpError(400, 'Signature invalide');
    return { ok: true, bytes: ctx.rawBody.length, bodyIsEmptyObject: JSON.stringify(ctx.body) === '{}', isBuffer: Buffer.isBuffer(ctx.rawBody) };
  }, { public: true, raw: true });

  route('POST', '/api/echo-raw', (ctx) => ({ text: ctx.rawBody.toString('utf8'), length: ctx.rawBody.length }), { perm: 'raw:test', raw: true });
  route('POST', '/api/tiny', (ctx) => ({ length: ctx.rawBody.length }), { public: true, raw: 10 });
  route('POST', '/api/json-only', (ctx) => ({ body: ctx.body, hasRaw: ctx.rawBody !== undefined }), { public: true });
  route('GET', '/api/raw-get', (ctx) => ({ length: ctx.rawBody.length }), { public: true, raw: true });
}];

let authorized = true;
const app = createApp({
  auth: { authenticate: (req) => USERS[req.headers['x-user']] ?? null, register: ({ route }) => route('GET', '/api/auth', () => ({}), { public: true }) },
  authorize: (ctx, action) => (action === 'raw:test' ? authorized : true),
  routes,
});
const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* pas du JSON */ }
  return { status: res.status, json, text };
}

// Un corps JSON dont la forme ne survit pas à JSON.parse / JSON.stringify : espaces, ordre des clés, échappements, nombres.
const AWKWARD = '{ "z": 1,\n  "a":  "é\\u00e9 \\/ ",   "n": 1.0,\n "big": 12345678901234567890 }';

test('le corps JSON « normal » ne restitue pas les octets d\'origine : c\'est pourquoi l\'option existe', () => {
  assert.notEqual(JSON.stringify(JSON.parse(AWKWARD)), AWKWARD);
  assert.notEqual(sign(JSON.stringify(JSON.parse(AWKWARD))), sign(AWKWARD), 'une signature calculée sur le corps réencodé ne correspondrait pas');
});

test('raw : la signature se vérifie sur les octets exacts reçus', async () => {
  const r = await post('/api/hook', AWKWARD, { 'content-type': 'application/json', 'x-signature': `sha256=${sign(AWKWARD)}` });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, bytes: Buffer.byteLength(AWKWARD), bodyIsEmptyObject: true, isBuffer: true });
  // un octet de différence : refusé
  const bad = await post('/api/hook', AWKWARD + ' ', { 'content-type': 'application/json', 'x-signature': `sha256=${sign(AWKWARD)}` });
  assert.deepEqual([bad.status, bad.json.error], [400, 'Signature invalide']);
});

test('raw : les octets non UTF-8 et les corps binaires passent intacts', async () => {
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0xc3, 0x28, 0x7b]); // pas de l'UTF-8 valide, pas du JSON
  const r = await post('/api/hook', bytes, { 'content-type': 'application/octet-stream', 'x-signature': sign(bytes) });
  assert.equal(r.status, 200);
  assert.equal(r.json.bytes, 8);
});

test('raw : tout type de contenu est accepté (le contrôle « JSON uniquement » ne s\'applique pas) ; les autres routes le gardent', async () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/xml']) {
    const r = await post('/api/hook', 'a=1&b=2', { 'content-type': type, 'x-signature': sign('a=1&b=2') });
    assert.equal(r.status, 200, type);
  }
  const normal = await post('/api/json-only', 'a=1', { 'content-type': 'text/plain' });
  assert.equal(normal.status, 415, 'une route ordinaire refuse toujours un corps non JSON (protection CSRF)');
  const json = await post('/api/json-only', '{"x":1}', { 'content-type': 'application/json' });
  assert.deepEqual(json.json, { body: { x: 1 }, hasRaw: false }, 'une route ordinaire reçoit le JSON analysé, et pas de rawBody');
});

test('raw : corps vide → Buffer vide ; GET accepté', async () => {
  const r = await post('/api/echo-raw', '', { 'x-user': 'alice' });
  assert.deepEqual(r.json, { text: '', length: 0 });
  assert.deepEqual(await (await fetch(`${base}/api/raw-get`)).json(), { length: 0 });
});

test('raw : limite de taille — 2 Mo par défaut, ou la taille donnée ; au-delà, 413', async () => {
  const big = Buffer.alloc(2e6 + 1, 97);
  const r = await post('/api/hook', big, { 'x-signature': sign(big) });
  assert.equal(r.status, 413);
  const ok = Buffer.alloc(2e6, 97);
  assert.equal((await post('/api/hook', ok, { 'x-signature': sign(ok) })).status, 200, 'pile à la limite : accepté');
  assert.equal((await post('/api/tiny', '0123456789')).json.length, 10);
  assert.equal((await post('/api/tiny', '0123456789!')).status, 413, 'limite personnalisée (10 octets)');
});

test('raw : une route privée exige la connexion, et le droit est vérifié AVANT de lire le corps', async () => {
  assert.equal((await post('/api/echo-raw', 'x')).status, 401);
  const ok = await post('/api/echo-raw', 'bonjour', { 'x-user': 'alice', 'content-type': 'text/plain' });
  assert.deepEqual(ok.json, { text: 'bonjour', length: 7 });
  authorized = false;
  try {
    const big = Buffer.alloc(3e6, 97); // dépasserait la limite : un refus 403 prouve que le corps n'a pas été lu
    const denied = await post('/api/echo-raw', big, { 'x-user': 'alice' });
    assert.equal(denied.status, 403);
  } finally {
    authorized = true;
  }
});

test('routes() indique les routes brutes', () => {
  const raws = app.routes().filter((r) => r.raw).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(raws, ['GET /api/raw-get', 'POST /api/echo-raw', 'POST /api/hook', 'POST /api/tiny']);
  assert.ok(app.routes().filter((r) => !r.raw).length > 40, 'les routes du cœur ne sont pas brutes');
  assert.ok(app.routes().filter((r) => r.path.startsWith('/api/watches')).every((r) => !r.raw));
});

test.after(async () => {
  await app.stop();
  dbm.db.close();
});
