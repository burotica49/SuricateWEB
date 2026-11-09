import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../test-support/server.js';
import { openPage, findChrome } from '../test-support/browser.js';

// Mode démo : aucun contrôle réseau pour le site créé ici.
const srv = await startServer({ env: { SURICATE_DEMO: '1' } });
test.after(() => srv.stop());
const skip = !findChrome() && 'Chrome/Chromium introuvable';

async function mobilePage(width) {
  const page = await openPage(`${srv.base}/`);
  await page.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'motdepasse-test-1' }) }).then((r) => r.status)`);
  await page.viewport(width, 800, { dpr: 2, mobile: true });
  await page.navigate(`${srv.base}/`);
  const wait = (expr, ms = 8000) => page.run(`new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearInterval(i); res(true); } else if (Date.now() - t0 > ${ms}) { clearInterval(i); rej(new Error('délai : ' + ${JSON.stringify(expr)})); } }, 80); })`);
  await wait('document.querySelector(".sidebar")');
  const open = async (hash, sel) => { await page.run(`location.hash = ${JSON.stringify(hash)}`); await wait(`document.querySelector(${JSON.stringify(sel)})`); await new Promise((r) => setTimeout(r, 250)); };
  return { page, wait, open };
}

const overflow = (page) => page.run(`(() => {
  const vw = document.documentElement.clientWidth;
  const out = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > vw + 1 && !e.closest('.tabs') && !e.closest('.table-wrap'); })
    .map((e) => e.tagName.toLowerCase() + '.' + String(e.className?.baseVal ?? e.className).split(' ').join('.') + '@' + Math.round(e.getBoundingClientRect().right)).slice(0, 5);
  return { vw, doc: document.documentElement.scrollWidth, out };
})()`);

test('téléphone : la frise de 90 jours et la page tiennent en largeur, de 320 à 414 px', { skip, timeout: 120000 }, async () => {
  const id = (await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Mobile', interval: 15 })).json.id;
  for (const width of [320, 360, 375, 414]) {
    const { page, open } = await mobilePage(width);
    try {
      for (const tab of ['disponibilite', '', 'modifications', 'alertes']) {
        await open(`#/sites/${id}${tab ? '/' + tab : ''}`, '.tabs');
        const r = await overflow(page);
        assert.equal(r.doc <= r.vw, true, `${width}px, onglet « ${tab || 'aperçu'} » : la page déborde (${r.doc}px pour ${r.vw}px) — ${r.out.join(', ')}`);
        assert.deepEqual(r.out, [], `${width}px, onglet « ${tab || 'aperçu'} » : éléments hors de l'écran`);
      }
      await open(`#/sites/${id}/disponibilite`, '.ub i');
      const bars = await page.run(`(() => { const ub = document.querySelector('.ub'); const b = ub.getBoundingClientRect(); const last = ub.lastElementChild.getBoundingClientRect(); return { n: ub.children.length, right: Math.round(last.right), edge: Math.round(b.right), vw: innerWidth, minW: Math.min(...[...ub.children].map((i) => i.getBoundingClientRect().width)) }; })()`);
      assert.equal(bars.n, 90, '90 jours affichés');
      assert.ok(bars.right <= bars.edge + 1 && bars.edge <= bars.vw, `${width}px : la dernière barre est dans l'écran (${bars.right}px / ${bars.vw}px)`);
      assert.ok(bars.minW >= 1, 'chaque barre reste visible');
    } finally { page.close(); }
  }
});

test('téléphone : la barre de navigation du bas tient en largeur (liens secondaires masqués sur très petit écran)', { skip, timeout: 90000 }, async () => {
  for (const [width, ext] of [[320, 0], [360, 0], [375, 2], [414, 2]]) {
    const { page, open } = await mobilePage(width);
    try {
      await open('#/', '.sidebar');
      const bar = await page.run(`(() => { const items = [...document.querySelectorAll('.sidebar a, .sidebar button')].filter((e) => e.getBoundingClientRect().width > 0); return { vw: innerWidth, maxRight: Math.max(...items.map((e) => Math.round(e.getBoundingClientRect().right))), ext: [...document.querySelectorAll('.side-actions a.ext')].filter((e) => e.getBoundingClientRect().width > 0).length, n: items.length }; })()`);
      assert.ok(bar.maxRight <= bar.vw, `${width}px : le dernier bouton de la barre (${bar.maxRight}px) est dans l'écran (${bar.vw}px)`);
      assert.equal(bar.ext, ext, `${width}px : ${ext ? 'GitHub et documentation visibles' : 'GitHub et documentation masqués'}`);
    } finally { page.close(); }
  }
});

test('téléphone : les onglets défilent, et on le voit (flèche, onglet actif amené à l’écran)', { skip, timeout: 90000 }, async () => {
  const id = (await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Onglets', interval: 15 })).json.id;
  const { page, open, wait } = await mobilePage(375);
  const state = () => page.run(`(() => { const w = document.querySelector('.tabs-wrap'); const s = w.querySelector('.tabs'); const on = s.querySelector('a.on').getBoundingClientRect(); const vis = (sel) => { const e = w.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; }; return { left: vis('.tabs-nav.l'), right: vis('.tabs-nav.r'), scroll: Math.round(s.scrollLeft), max: s.scrollWidth - s.clientWidth, activeIn: on.left >= 0 && on.right <= innerWidth + 1 }; })()`);
  try {
    // 1er onglet : il en reste à droite, rien à gauche.
    await open(`#/sites/${id}`, '.tabs-wrap');
    let s = await state();
    assert.ok(s.max > 40, 'les onglets ne tiennent pas dans 375 px : ils défilent');
    assert.deepEqual([s.left, s.right], [false, true], 'flèche à droite seulement');
    assert.equal(s.activeIn, true);

    // La flèche fait défiler et révèle l'autre côté.
    await page.run(`document.querySelector('.tabs-nav.r').click()`);
    await wait(`document.querySelector('.tabs').scrollLeft > 100`);
    s = await state();
    assert.equal(s.left, true, 'on peut revenir en arrière');

    // Dernier onglet : il est visible dès l'arrivée (avant, il pouvait être hors de l'écran).
    await open(`#/sites/${id}/domaine`, '.tabs-wrap'); // le dernier onglet d'un site sans CMS
    await wait(`document.querySelector('.tabs').scrollLeft > 0`);
    s = await state();
    assert.equal(s.activeIn, true, 'l’onglet actif est amené à l’écran');
    assert.deepEqual([s.left, s.right], [true, false], 'flèche à gauche seulement, au bout');
  } finally { page.close(); }

  // Écran large : tout tient, aucune flèche.
  const desk = await openPage(`${srv.base}/`, { width: 1280, height: 900 });
  try {
    await desk.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'motdepasse-test-1' }) }).then((r) => r.status)`);
    await desk.navigate(`${srv.base}/`);
    await desk.run(`new Promise((res) => { const i = setInterval(() => { if (document.querySelector('.sidebar')) { clearInterval(i); res(); } }, 80); })`);
    await desk.run(`location.hash = '#/sites/${id}'`);
    await desk.run(`new Promise((res) => { const i = setInterval(() => { if (document.querySelector('.tabs-wrap')) { clearInterval(i); res(); } }, 80); })`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await desk.run(`document.querySelector('.tabs-wrap').className`), 'tabs-wrap', 'bureau : pas de flèche inutile');
  } finally { desk.close(); }
});
