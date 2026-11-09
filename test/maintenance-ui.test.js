import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../test-support/server.js';
import { openPage, findChrome } from '../test-support/browser.js';

// Mode démo : aucun contrôle réseau n'est lancé pour le site créé ici.
const srv = await startServer({ env: { SURICATE_DEMO: '1' } });
test.after(() => srv.stop());

const skip = !findChrome() && 'Chrome/Chromium introuvable';

test('interface : planifier, voir, terminer une maintenance', { skip, timeout: 90000 }, async () => {
  const created = await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Site en maintenance', interval: 15 });
  const id = created.json.id;
  const page = await openPage(`${srv.base}/`);
  const wait = (expr, ms = 8000) => page.run(`new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearInterval(i); res(true); } else if (Date.now() - t0 > ${ms}) { clearInterval(i); rej(new Error('délai : ' + ${JSON.stringify(expr)})); } }, 80); })`);
  const clickText = (sel, text) => page.run(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim().includes(${JSON.stringify(text)})).click()`);
  try {
    await page.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'motdepasse-test-1' }) }).then((r) => r.status)`);
    await page.navigate(`${srv.base}/`);
    await wait('document.querySelector(".sidebar")');
    await page.run(`location.hash = '#/sites/${id}'`);
    await wait('document.querySelector(".detail-head")');
    assert.equal(await page.run('!!document.querySelector(".incident.info")'), false, 'pas de bandeau avant');

    // Une date passée est refusée côté interface comme côté API : rien n'est enregistré.
    await clickText('.detail-head .btn', 'Maintenance');
    await wait('document.querySelector(".modal")');
    assert.equal(await page.run('document.querySelector(".modal .field:not([hidden]) input[type=datetime-local]") === null'), true, 'le champ « Début » est masqué tant que « Maintenant » est choisi');
    await page.run(`(() => { const m = document.querySelector('.modal'); const sel = m.querySelector('select'); sel.value = 'later'; sel.dispatchEvent(new Event('change')); m.querySelector('input[type=datetime-local]').value = '2020-01-01T10:00'; })()`);
    await clickText('.modal .btn', 'Démarrer');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await srv.get(`/api/watches/${id}`)).json.maintenance.length, 0, 'date passée : refusée');
    assert.equal(await page.run('!!document.querySelector(".modal")'), true, 'le dialogue reste ouvert pour corriger');

    // « Maintenant », 2 heures, avec une note.
    await page.run(`(() => { const m = document.querySelector('.modal'); const sel = m.querySelector('select'); sel.value = 'now'; sel.dispatchEvent(new Event('change')); const [, dur] = m.querySelectorAll('select'); dur.value = '120'; m.querySelector('input[maxlength]').value = 'Mise à jour du CMS'; })()`);
    await clickText('.modal .btn', 'Démarrer');
    await wait('document.querySelector(".incident.info")');
    const banner = await page.run('document.querySelector(".incident.info").textContent');
    assert.match(banner, /Maintenance en cours jusqu'à/);
    assert.match(banner, /Mise à jour du CMS/);
    assert.match(banner, /retient ses alertes/);
    assert.match(await page.run('document.querySelector(".detail-head h1").textContent'), /Maintenance/, 'pastille dans le titre');

    const api = (await srv.get(`/api/watches/${id}`)).json;
    assert.equal(api.maintenance.length, 1);
    const len = api.maintenance[0].end - api.maintenance[0].start;
    assert.equal(len, 120 * 60e3, 'durée de 2 heures');
    assert.ok(api.maintenanceUntil > Date.now() + 119 * 60e3);

    // Tableau de bord : la pastille suit.
    await page.run(`location.hash = '#/'`);
    await wait('document.querySelector(".site")');
    assert.match(await page.run('document.querySelector(".site .pill.info").title'), /Maintenance jusqu/);

    // Fin anticipée : la surveillance reprend tout de suite.
    await page.run(`location.hash = '#/sites/${id}'`);
    await wait('document.querySelector(".incident.info")');
    await clickText('.incident.info .btn', 'Terminer maintenant');
    await wait('!document.querySelector(".incident.info")');
    assert.equal((await srv.get(`/api/watches/${id}`)).json.maintenanceUntil, null);
    assert.equal((await srv.get(`/api/watches/${id}`)).json.maintenance.length, 0);
  } finally {
    page.close();
  }
});

test('API : durée bornée, début passé = maintenant, début lointain borné, site inconnu', async () => {
  const id = (await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Bornes', interval: 15 })).json.id;
  const now = Date.now();
  let r = await srv.post(`/api/watches/${id}/maintenance`, { minutes: 1 });
  assert.equal(r.status, 200);
  let m = r.json.maintenance[0];
  assert.equal(m.end - m.start, 5 * 60e3, 'minimum 5 minutes');
  assert.ok(Math.abs(m.start - now) < 5000, 'sans début : maintenant');

  r = await srv.post(`/api/watches/${id}/maintenance`, { minutes: 999999, start: now - 3600e3 });
  m = r.json.maintenance.at(-1);
  assert.equal(m.end - m.start, 7 * 24 * 60 * 60e3, 'maximum 7 jours');
  assert.ok(Math.abs(m.start - now) < 5000, 'début passé : maintenant');

  r = await srv.post(`/api/watches/${id}/maintenance`, { minutes: 60, start: now + 400 * 86400e3 });
  m = r.json.maintenance.at(-1);
  assert.ok(m.start <= Date.now() + 90 * 86400e3 + 1000, 'au plus 90 jours à l’avance');

  r = await srv.post(`/api/watches/${id}/maintenance`, { minutes: 60, note: `a\u0000b${'x'.repeat(300)}` });
  assert.ok(r.json.maintenance.at(-1).note.length <= 140);
  assert.equal(r.json.maintenance.at(-1).note.includes('\u0000'), false);

  assert.equal((await srv.post('/api/watches/99999/maintenance', { minutes: 60 })).status, 404);
  assert.equal((await srv.call('DELETE', '/api/maintenance/99999')).status, 404);
  srv.logout();
  assert.equal((await srv.post(`/api/watches/${id}/maintenance`, { minutes: 60 })).status, 401, 'réservé aux utilisateurs connectés');
  assert.equal((await srv.call('DELETE', '/api/maintenance/1')).status, 401);
  assert.equal(await srv.login(), 200);
});
