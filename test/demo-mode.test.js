import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../test-support/server.js';

// Le mode démo (npm run demo, captures du README) ne doit JAMAIS contacter un site : même sur demande explicite.
const srv = await startServer({ env: { SURICATE_DEMO: '1' } });
test.after(() => srv.stop());

test('mode démo : « Vérifier maintenant » ne fait aucune requête et ne modifie rien', async () => {
  // Port 9 (discard) : s'il y avait une requête, elle échouerait ET laisserait une trace (contrôle enregistré).
  const created = await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Site fictif', interval: 15 });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.id;

  const r = await srv.post(`/api/watches/${id}/check`, {});
  assert.match(JSON.stringify(r.json), /Mode démo/, "l'interface explique pourquoi rien ne s'est passé");

  const w = (await srv.get(`/api/watches/${id}`)).json;
  assert.equal(w.checks.length, 0, 'aucun contrôle enregistré');
  assert.equal(w.outages?.length ?? 0, 0, 'aucune panne inventée');
});

test('mode démo : le serveur répond et les réglages restent accessibles', async () => {
  assert.equal((await srv.get('/api/settings')).status, 200);
});
