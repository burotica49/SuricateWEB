// npm run docs:screenshots : régénère docs/screenshots/*.png à partir des données FICTIVES de la démo.
//
// Principe : on fabrique une base de démonstration (scripts/docs/demo-data.js), on lance VigieWeb dessus en « mode démo »
// (aucun contrôle réseau), puis on pilote un vrai Chrome qui se connecte, parcourt les écrans et les photographie.
// Les images ne contiennent donc que des données inventées (domaines « .example », IP de documentation).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeSites, linesOf, DEFACED_LINES, SITES } from './fake-sites.js';
import { seedDemo, DEMO_USER, DEMO_PASSWORD } from './demo-data.js';
import { startServer } from '../../test-support/server.js';
import { openPage, findChrome } from '../../test-support/browser.js';
import { buildMessage } from '../../src/telegram.js';
import { diffLines, preview } from '../../src/diff.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const W = 1440;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!findChrome()) {
  console.error('Chrome / Chromium est introuvable : impossible de générer les captures (définissez CHROME_PATH).');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'vigieweb-docs-'));
const fake = await startFakeSites();
let srv;
let page;
const written = [];

try {
  console.log('1/3  Données fictives…');
  const { images } = await seedDemo({ dataDir, fakeSitesBase: fake.base });

  // Message Telegram : le VRAI texte produit par l'application (buildMessage), pas une maquette rédigée à la main.
  const defacedAlerts = [
    { severity: 'critical', title: 'Le contenu de la page a été entièrement remplacé', detail: '3 ligne(s) ajoutée(s), 13 supprimée(s) · similarité 0 %', diffPreview: preview(diffLines(linesOf(SITES.dupont, { promo: true }), DEFACED_LINES).ops, 8, 70) },
    { severity: 'critical', title: '3 textes suspects détectés : « hacked by », « cyber team », « greetz to »', detail: '…hacked by anonymous cyber team your security is a joke. greetz to all.…' },
    { severity: 'critical', title: 'Iframe externe injectée dans la page', detail: 'malware-cdn.example' },
  ];
  const text = buildMessage({ id: 1, name: SITES.dupont.name, url: `https://${SITES.dupont.domain}/` }, defacedAlerts, { telegram: { includeDiff: true }, baseUrl: 'https://vigieweb.exemple-societe.example' });
  const photoB64 = images.dupontDefaced.image.toString('base64');
  fake.setPage('/telegram', `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}body{background:#0e1621;font:15px/1.45 -apple-system,"Segoe UI",Helvetica,sans-serif;color:#e8ecf0;padding:26px}
    #chat{width:540px;display:flex;flex-direction:column;gap:6px}
    .bot{display:flex;align-items:center;gap:12px;padding:0 4px 12px}.av{width:40px;height:40px;border-radius:50%;background:#4f46e5;display:grid;place-items:center;font-weight:800}
    .bot b{display:block;font-size:16px}.bot span{font-size:13px;color:#7f91a4}
    .m{background:#182533;border-radius:14px 14px 14px 4px;padding:9px 13px 7px;white-space:pre-wrap;word-break:break-word;max-width:100%}
    .m b{color:#fff}.m a{color:#6ab3f3}.m pre{background:#0e1621;border-left:3px solid #6ab3f3;border-radius:6px;padding:8px 10px;margin:6px 0 2px;font:12.5px/1.45 ui-monospace,Menlo,monospace;color:#c9d6e3;white-space:pre-wrap}
    .t{display:block;text-align:right;font-size:12px;color:#7f91a4;margin-top:2px}
    .p{background:#182533;border-radius:14px 14px 14px 4px;padding:4px 4px 7px;max-width:100%}.p img{display:block;width:100%;border-radius:11px}.p div{padding:7px 9px 0;white-space:pre-wrap}
  </style><div id="chat">
    <div class="bot"><div class="av">V</div><div><b>VigieWeb Bot</b><span>bot</span></div></div>
    <div class="m">${text}<span class="t">14:32</span></div>
    <div class="p"><img src="data:image/jpeg;base64,${photoB64}"><div>📸 ${SITES.dupont.name} — la page au moment de l'alerte<span class="t">14:32</span></div></div>
  </div>`);

  console.log('2/3  Serveur de démonstration…');
  srv = await startServer({ user: DEMO_USER, password: DEMO_PASSWORD, dataDir, env: { VIGIE_DEMO: '1' } });
  const list = (await srv.get('/api/watches')).json;
  const id = (name) => list.find((w) => w.name === name).id;

  console.log('3/3  Captures…');
  page = await openPage(`${srv.base}/`, { width: W, height: 900 });
  await page.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '${DEMO_USER}', password: '${DEMO_PASSWORD}' }) }).then((r) => r.status)`);

  const waitFor = (expr, ms = 15000) => page.run(`new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { let ok = false; try { ok = !!(${expr}); } catch (e) {} if (ok) { clearInterval(i); res(true); } else if (Date.now() - t0 > ${ms}) { clearInterval(i); rej(new Error('Délai dépassé : ' + ${JSON.stringify(expr)})); } }, 100); })`);
  const imagesLoaded = () => waitFor('[...document.images].every((i) => i.complete && i.naturalWidth > 0)');
  /** Va sur un écran de l'application et attend qu'il soit réellement affiché (élément présent, images chargées). */
  const go = async (hash, sel) => {
    await page.run(`location.hash = ${JSON.stringify(hash)}`);
    await waitFor(`document.querySelector(${JSON.stringify(sel)})`);
    await imagesLoaded();
    await sleep(500); // animations d'apparition
  };
  const save = async (name, buf) => {
    writeFileSync(join(OUT, name), buf);
    written.push([name, statSync(join(OUT, name)).size]);
    console.log(`     ✓ ${name}  (${Math.round(statSync(join(OUT, name)).size / 1024)} Ko)`);
  };
  const fit = (o = {}) => page.fit(W, o);

  const reload = async () => { await page.navigate(`${srv.base}/`); await waitFor('document.querySelector(".sidebar")'); };
  await page.run(`localStorage.setItem('vigie-theme', 'light'); localStorage.setItem('vigie-view', 'groups'); true`);
  await reload();

  // ── Thème clair ──
  await go('#/', '.grp .site');
  await fit({ max: 1800 });
  await save('tableau-de-bord.png', await page.screenshot());

  await go(`#/sites/${id('Nova Boutique')}`, '.pv-img img');
  await waitFor('document.querySelector(".ub")');
  await fit({ max: 2200 });
  await save('site-apercu.png', await page.screenshot());

  await go(`#/sites/${id('Maison Lumière')}/disponibilite`, '.uhero');
  await waitFor('document.querySelector(".chart")');
  await fit({ max: 2200 });
  await save('disponibilite.png', await page.screenshot());

  await go(`#/sites/${id('Fromagerie Dupont')}/modifications`, '.tl-item');
  await page.run(`document.querySelector('.tl-item .tl-head').click()`);
  await waitFor('document.querySelector(".diff .ln")');
  await fit({ max: 1800 });
  await save('modifications.png', await page.screenshot());

  await go(`#/sites/${id('Fromagerie Dupont')}/captures`, '.shots .shot');
  await fit({ max: 1800 });
  await save('captures.png', await page.screenshot());

  // Comparaison avant / après : la visionneuse, en vue côte à côte.
  await page.viewport(W, 900);
  await page.run(`document.querySelector('.shots .shot').click()`);
  await waitFor('document.querySelector(".lb")');
  await page.run(`[...document.querySelectorAll('.lb-actions button')].find((b) => b.title.startsWith('Comparer')).click()`);
  await waitFor('document.querySelector(".lb-stage.two img")');
  await sleep(600);
  await imagesLoaded();
  await save('comparaison.png', await page.screenshot());
  await page.run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);

  await go(`#/sites/${id('Cabinet Martin')}/domaine`, '.chk');
  await fit({ max: 2400 });
  await save('domaine-dns.png', await page.screenshot());

  await go('#/alertes', '.alert');
  await fit({ max: 2000 });
  await save('alertes.png', await page.screenshot());

  await go('#/reglages', '.settings section');
  await fit({ max: 2600 });
  await save('reglages.png', await page.screenshot({ clipSelector: '.settings section:first-child' }));

  // Formulaire d'ajout (tiroir) : section « Capture d'écran » dépliée.
  await go('#/', '.grp .site');
  await page.viewport(W, 1000);
  await page.run(`document.querySelector('.page-head .btn.primary').click()`);
  await waitFor('document.querySelector(".drawer")');
  await sleep(500);
  await save('formulaire.png', await page.screenshot());
  await page.run(`document.querySelector('.drawer .drawer-head .btn').click(); true`);

  // Message Telegram (aperçu du vrai message produit par l'application).
  await page.navigate(`${fake.base}/telegram`);
  await page.viewport(620, 1000);
  await sleep(500);
  await save('telegram.png', await page.screenshot({ clipSelector: '#chat' }));
  await page.viewport(W, 900);

  // ── Thème sombre ──
  await page.navigate(`${srv.base}/`);
  await page.run(`localStorage.setItem('vigie-theme', 'dark'); true`);
  await reload();
  await go('#/', '.grp .site');
  await fit({ max: 1800 });
  await save('tableau-de-bord-sombre.png', await page.screenshot());

  // ── Mobile ──
  await page.run(`localStorage.setItem('vigie-theme', 'light'); true`);
  await reload();
  await page.viewport(390, 844, { dpr: 2, mobile: true });
  await go('#/', '.grp .site');
  await page.fit(390, { max: 1700, dpr: 2, mobile: true });
  await save('mobile.png', await page.screenshot());

  const total = written.reduce((s, [, n]) => s + n, 0);
  console.log(`\n${written.length} captures dans ${OUT} (${(total / 1048576).toFixed(1)} Mo au total).`);
} finally {
  page?.close();
  await srv?.stop();
  await fake.close();
  rmSync(dataDir, { recursive: true, force: true });
}
