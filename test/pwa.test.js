import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../test-support/server.js';

const pngSize = (buf) => {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'signature PNG');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
};

test('icônes PWA : PNG aux tailles exigées pour l’installation', () => {
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    assert.deepEqual(pngSize(readFileSync(new URL(`../public/${file}`, import.meta.url))), { w: size, h: size }, file);
  }
});

const srv = await startServer();
test.after(() => srv.stop());

test('manifest : lié dans le head et servi comme manifeste web', async () => {
  const html = await srv.get('/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.text, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html.text, /name="theme-color"/);
  assert.match(html.text, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);

  const man = await srv.get('/manifest.webmanifest');
  assert.equal(man.status, 200);
  assert.match(man.headers.get('content-type'), /^application\/manifest\+json/);
  const json = JSON.parse(man.text);
  assert.equal(json.short_name, 'VigieWeb');
  assert.equal(json.start_url, '/');
  assert.equal(json.display, 'standalone');
  assert.equal(json.lang, 'fr');
  assert.ok(json.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png'));
  assert.ok(json.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png'));

  for (const path of ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/sw.js']) {
    const res = await srv.get(path);
    assert.equal(res.status, 200, path);
  }
  assert.match((await srv.get('/sw.js')).text, /addEventListener\('fetch'/);
  assert.match((await srv.get('/icon-192.png')).headers.get('content-type'), /^image\/png/);
});
