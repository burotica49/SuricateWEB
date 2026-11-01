// Test de bout en bout : vrai serveur + vrai Chrome. Il existe parce que deux défauts de l'interface (une collision de
// classe CSS, des attributs commentés par erreur) étaient invisibles à toute analyse statique et à tous les tests unitaires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../test-support/server.js';
import { openPage, findChrome } from '../test-support/browser.js';

const skip = !findChrome() && 'Chrome/Chromium introuvable';

test('interface des groupes : poignées, glisser-déposer, clavier, filtre, persistance', { skip, timeout: 90000 }, async () => {
  const srv = await startServer();
  let page;
  try {
    // Données : 2 groupes (dont un vide) et 4 sites désactivés (aucun réseau).
    const g = async (name) => (await srv.post('/api/groups', { name })).json.id;
    const [clients, interne, vide] = [await g('Clients'), await g('Interne'), await g('Vide')];
    const w = async (name, groupId) => (await srv.post('/api/watches', { url: `https://${name.toLowerCase()}.test/`, name, enabled: false, groupId })).json.id;
    await w('Alpha', clients); await w('Bravo', clients); await w('Charlie', interne); await w('Delta', null);

    page = await openPage(`${srv.base}/`);
    // Connexion par l'API de la page (le cookie de session est posé sur son origine), puis rechargement.
    await page.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'motdepasse-test-1' }) }).then((r) => r.status)`);
    await page.navigate(`${srv.base}/`);
    await page.run(`new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (document.querySelector('.grp .site')) { clearInterval(i); res(true); } else if (Date.now() - t0 > 8000) { clearInterval(i); rej(new Error('liste non affichée : ' + document.body.innerText.slice(0, 200))); } }, 100); })`);

    // Aides exécutées dans la page (à redéfinir après chaque rechargement).
    const HELPERS = `window.T = {
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      row: (n) => [...document.querySelectorAll('.site')].find((r) => r.querySelector('.n').textContent === n),
      sec: (n) => [...document.querySelectorAll('.grp')].find((s) => s.querySelector('h3')?.textContent === n),
      layout: () => [...document.querySelectorAll('.grp')].map((s) => (s.querySelector('h3')?.textContent ?? '∅') + ':' + [...s.querySelectorAll('.site .n')].map((n) => n.textContent).join(',')).join(' | '),
      async dnd(src, target, frac = 0.5) {
        const dt = new DataTransfer();
        const fire = (el, type, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 300, clientY: y }));
        fire(src, 'dragstart', 10);
        const r = target.getBoundingClientRect(); const y = r.top + r.height * frac;
        const accepted = !fire(target, 'dragover', y);
        const marks = { line: !!document.querySelector('.drop-line'), hover: document.querySelectorAll('.drop-hover').length };
        fire(target, 'drop', y); fire(src, 'dragend', 0);
        await T.wait(400);
        return { accepted, ...marks };
      },
      key: async (el, key) => { el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await T.wait(350); },
    }; true`;
    await page.run(HELPERS);
    const run = (e) => page.run(`(async () => (${e}))()`);
    const server = async () => {
      const ws = (await srv.get('/api/watches')).json.sort((a, b) => a.position - b.position);
      const gs = (await srv.get('/api/groups')).json;
      const names = Object.fromEntries(gs.map((x) => [x.id, x.name]));
      return [...gs.map((x) => x.name), '∅'].map((n) => `${n}:${ws.filter((x) => (names[x.groupId] ?? '∅') === n).map((x) => x.name).join(',')}`).join(' | ');
    };

    // 1. Rendu et poignées : attributs présents, pas de collision avec le style des lignes.
    assert.equal(await run('T.layout()'), 'Clients:Alpha,Bravo | Interne:Charlie | Vide: | Sans groupe:Delta');
    const hd = await run(`(() => { const h = document.querySelector('.site .handle'); const cs = getComputedStyle(h); return { attrs: h.getAttributeNames().sort(), kind: h.dataset.kind, draggable: h.getAttribute('draggable'), tabindex: h.getAttribute('tabindex'), cls: h.className, padding: cs.padding, display: cs.display, width: Math.round(h.getBoundingClientRect().width) }; })()`);
    assert.deepEqual(hd.attrs, ['aria-label', 'class', 'data-id', 'data-kind', 'draggable', 'role', 'tabindex', 'title']);
    assert.deepEqual([hd.kind, hd.draggable, hd.tabindex], ['site', 'true', '0']);
    assert.ok(!hd.cls.split(' ').includes('site'), 'la poignée ne doit pas porter la classe « site » des lignes');
    assert.equal(hd.padding, '0px', 'aucun style de ligne ne s\'applique à la poignée');
    assert.ok(hd.width <= 30, `poignée compacte (${hd.width}px)`);
    assert.equal(await run(`document.querySelectorAll('.grp-head .handle').length`), 3, 'une poignée par groupe (sauf « Sans groupe »)');

    // 2. Vers un groupe vide : la zone est mise en évidence, puis le site y arrive (écran ET serveur).
    const r1 = await run(`T.dnd(T.row('Bravo').querySelector('.handle'), T.sec('Vide').querySelector('.sites'))`);
    assert.deepEqual([r1.accepted, r1.hover, r1.line], [true, 1, false], 'groupe vide : surbrillance, pas de ligne');
    assert.equal(await run('T.layout()'), 'Clients:Alpha | Interne:Charlie | Vide:Bravo | Sans groupe:Delta');
    assert.equal(await server(), 'Clients:Alpha | Interne:Charlie | Vide:Bravo | ∅:Delta');

    // 3. Entre deux sites d'un autre groupe (moitié basse de Charlie → après lui) : ligne d'insertion.
    const r2 = await run(`T.dnd(T.row('Delta').querySelector('.handle'), T.row('Charlie'), 0.85)`);
    assert.deepEqual([r2.accepted, r2.line], [true, true]);
    assert.equal(await server(), 'Clients:Alpha | Interne:Charlie,Delta | Vide:Bravo | ∅:');
    assert.match(await run('T.layout()'), /Sans groupe:$/ , '« Sans groupe » vide : zone de dépôt conservée');

    // 4. Ordre des groupes : Vide avant Clients.
    await run(`T.dnd(T.sec('Vide').querySelector('.handle'), T.sec('Clients'), 0.1)`);
    assert.equal(await server(), 'Vide:Bravo | Clients:Alpha | Interne:Charlie,Delta | ∅:');

    // 5. Clavier : ↓ sur Bravo franchit la frontière ; Entrée n'ouvre pas le site ; annonce pour lecteur d'écran.
    await run(`T.key(T.row('Bravo').querySelector('.handle'), 'ArrowDown')`);
    assert.equal(await server(), 'Vide: | Clients:Bravo,Alpha | Interne:Charlie,Delta | ∅:');
    assert.equal(await run(`document.activeElement?.dataset?.kind + ':' + document.activeElement.closest('.site')?.querySelector('.n').textContent`), 'site:Bravo', 'le focus suit le site déplacé');
    assert.match(await run(`document.querySelector('[aria-live]').textContent`), /« Bravo » : position 1 sur 2, groupe « Clients »/);
    await run(`T.key(document.activeElement, 'Enter')`);
    assert.equal(await run('location.hash'), '', 'Entrée sur la poignée n\'ouvre pas la page du site');

    // 6. Groupe replié : il accepte un dépôt sur son en-tête ; l'état replié est mémorisé par le serveur.
    await run(`(T.sec('Interne').querySelector('.gtoggle').click(), T.wait(400))`);
    assert.equal((await srv.get('/api/groups')).json.find((x) => x.name === 'Interne').collapsed, true);
    const r3 = await run(`T.dnd(T.row('Alpha').querySelector('.handle'), T.sec('Interne').querySelector('.grp-head'))`);
    assert.equal(r3.hover, 1);
    assert.equal(await server(), 'Vide: | Clients:Bravo | Interne:Charlie,Delta,Alpha | ∅:');

    // 7. Un filtre désactive la réorganisation (des sites sont cachés) et déplie les groupes repliés.
    await run(`(() => { const i = document.querySelector('input[type=search]'); i.value = 'Charlie'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.deepEqual(await run(`({ dnd: document.querySelector('.sections').classList.contains('dnd'), visibles: [...document.querySelectorAll('.handle')].filter((h) => getComputedStyle(h).display !== 'none').length, groupes: [...document.querySelectorAll('.grp h3')].map((h) => h.textContent), replie: !!document.querySelector('.grp.collapsed') })`),
      { dnd: false, visibles: 0, groupes: ['Interne'], replie: false });

    // 8. Rechargement complet : l'organisation et l'état replié sont ceux du serveur.
    await page.navigate(`${srv.base}/`);
    await page.run(HELPERS);
    await run(`new Promise((r) => { const i = setInterval(() => document.querySelector('.grp .site') && (clearInterval(i), r()), 100); })`);
    assert.equal(await run('T.layout()'), 'Vide: | Clients:Bravo | Interne:Charlie,Delta,Alpha | Sans groupe:', 'ordre conservé après rechargement');
    assert.equal(await run(`T.sec('Interne').querySelector('.sites').hidden`), true, 'les lignes du groupe replié sont masquées');
    assert.equal(await run(`T.sec('Interne').classList.contains('collapsed')`), true);
    assert.equal(await server(), 'Vide: | Clients:Bravo | Interne:Charlie,Delta,Alpha | ∅:');

    void interne; void vide;
  } finally {
    page?.close();
    await srv.stop();
  }
});
