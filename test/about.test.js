import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../test-support/server.js';
import { openPage, findChrome } from '../test-support/browser.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const srv = await startServer();
test.after(() => srv.stop());

test('package.json : champs utilisés par la barre latérale', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'version semver');
  assert.match(pkg.repository?.url ?? '', /^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
  assert.match(pkg.homepage ?? '', /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+#readme$/);
  assert.equal(pkg.license, 'Apache-2.0');
  const licence = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(licence, /Apache License\s+Version 2\.0, January 2004/, 'LICENSE contient le texte Apache 2.0');
  assert.equal(licence.includes('MIT License'), false, "plus de trace de l'ancienne licence");
  assert.match(readFileSync(new URL('../NOTICE', import.meta.url), 'utf8'), /^SuricateWEB\nCopyright 2026 /);
});

test('API : version et liens dérivés de package.json, réservés aux utilisateurs connectés', async () => {
  const s = (await srv.get('/api/settings')).json;
  assert.equal(s.app.version, pkg.version, 'la version affichée EST celle de package.json');
  assert.equal(s.app.repoUrl, pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''), 'sans « git+ » ni « .git »');
  assert.equal(s.app.docsUrl, pkg.homepage);
  for (const u of [s.app.repoUrl, s.app.docsUrl]) assert.match(u, /^https:\/\//, 'jamais autre chose que http(s)');

  assert.equal((await srv.get('/api/auth')).text.includes(pkg.version), false, "la version n'est pas exposée avant la connexion");
  srv.logout();
  assert.equal((await srv.get('/api/settings')).status, 401);
  assert.equal(await srv.login(), 200);
});

test('interface : version à côté du nom, liens GitHub et documentation en pied de barre latérale', { skip: !findChrome() && 'Chrome/Chromium introuvable', timeout: 60000 }, async () => {
  const page = await openPage(`${srv.base}/`);
  try {
    await page.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'motdepasse-test-1' }) }).then((r) => r.status)`);
    await page.navigate(`${srv.base}/`);
    await page.run(`new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (document.querySelector('.sidebar .brand')) { clearInterval(i); res(true); } else if (Date.now() - t0 > 8000) { clearInterval(i); rej(new Error('barre latérale absente')); } }, 100); })`);

    const ui = await page.run(`(() => {
      const brand = document.querySelector('.sidebar .brand');
      const links = [...document.querySelectorAll('.side-actions a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel, label: a.getAttribute('aria-label'), svg: !!a.querySelector('svg'), w: Math.round(a.getBoundingClientRect().width) }));
      const order = [...document.querySelectorAll('.side-actions > *')].map((e) => e.tagName.toLowerCase() + ':' + (e.getAttribute('aria-label') || '').split(' ')[0]);
      return { name: brand.querySelector('.brand-name').firstChild.textContent, ver: brand.querySelector('.ver')?.textContent, verTitle: brand.querySelector('.ver')?.title, sub: brand.querySelector('small').textContent, links, order };
    })()`);
    assert.equal(ui.name, 'SuricateWEB');
    assert.equal(ui.ver, `v${pkg.version}`);
    assert.equal(ui.verTitle, `Version ${pkg.version}`);
    assert.equal(ui.sub, 'Surveillance de sites');
    assert.deepEqual(ui.links.map((l) => l.href), [pkg.homepage.replace('#readme', ''), pkg.homepage]);
    assert.ok(ui.links.every((l) => l.target === '_blank' && l.rel.split(' ').includes('noopener') && l.rel.split(' ').includes('noreferrer')), 'nouvel onglet, sans fuite de la page appelante');
    assert.ok(ui.links.every((l) => l.svg && l.w >= 28 && l.label.endsWith('(nouvel onglet)')), 'icônes visibles, libellé accessible');
    assert.deepEqual(ui.order, ['a:Dépôt', 'a:Documentation', 'button:Changer', 'button:Se'], 'liens puis thème puis déconnexion');
  } finally {
    page.close();
  }
});
