// Liens de compte et jauge d'usage de l'interface : annoncés par le serveur (capabilities.accountLinks / usageUrl), vus dans un vrai Chrome.
// Rien ne s'affiche sans eux (cœur auto-hébergé), un lien dangereux n'est jamais montré, et les captures hors forfait sont expliquées.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPage, findChrome } from '../test-support/browser.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-planui-'));

const { createApp } = await import('../src/app.js');
const { resetExtensions } = await import('../src/extensions.js');
const dbm = await import('../src/db.js');

const skip = !findChrome() && 'Chrome/Chromium introuvable';
const HELPERS = `window.T = {
  until: (fn, ms = 6000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { let v; try { v = fn(); } catch {} if (v) { clearInterval(i); res(v); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('délai : ' + fn)); } }, 40); }),
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
  visible: (sel) => { const e = document.querySelector(sel); return !!e && !e.hidden && e.offsetParent !== null; },
}; true`;

/** Authentification factice : toujours connecté (compte 1, qui possède les sites du cœur par défaut). */
const openAuth = () => ({
  kind: 'fake',
  authenticate: () => ({ user: { id: 1, name: 'marie@exemple.fr' }, account: { id: 1 } }),
  register({ route }) { route('GET', '/api/auth', () => ({ required: true, authenticated: true }), { public: true }); },
});

async function withPage(t, options, fn) {
  const app = createApp({ env: { ...process.env, TELEGRAM_POLL: '0' }, auth: openAuth(), ...options });
  const port = await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.stop(); resetExtensions(); });
  const page = await openPage(`http://127.0.0.1:${port}/`);
  try {
    await page.run(HELPERS);
    await fn(page, port);
  } finally {
    await page.close();
  }
}

test('jauge et lien « Mon forfait » : annoncés par le serveur, texte seulement, lien dangereux ignoré', { skip, timeout: 90000 }, async (t) => {
  const usage = { plan: { name: 'Perso' }, usage: { sites: { active: 1, total: 1, max: 1 } } };
  await withPage(t, {
    capabilities: { usageUrl: '/api/account/plan', accountLinks: [{ label: 'Mon forfait', href: '/api/account/pages/forfaits' }, { label: 'Piège', href: 'javascript:alert(1)' }, { label: 'Ailleurs', href: '//evil.example/' }] },
    routes: [({ route }) => route('GET', '/api/account/plan', () => usage)],
  }, async (page) => {
    await page.run("T.until(() => T.visible('#plan-box'))");
    assert.match(await page.run("T.text('#plan-box')"), /Forfait Perso/);
    assert.match(await page.run("T.text('#plan-box')"), /1 \/ 1 site surveillé/);
    assert.equal(await page.run("document.querySelector('#plan-box .gauge').classList.contains('full')"), true, 'jauge pleine : mise en évidence');
    assert.equal(await page.run("document.querySelector('#plan-box .gauge').getAttribute('aria-valuemax')"), '1');
    const links = await page.run("[...document.querySelectorAll('#plan-box a')].map((a) => [a.textContent, a.getAttribute('href')])");
    assert.deepEqual(links, [['Mon forfait', '/api/account/pages/forfaits']], 'ni « javascript: » ni un autre site');
  });
});

test('forfait illimité : pas de barre, « illimité » ; sans capacités : rien n\'est affiché', { skip, timeout: 90000 }, async (t) => {
  await withPage(t, {
    capabilities: { usageUrl: '/api/account/plan' },
    routes: [({ route }) => route('GET', '/api/account/plan', () => ({ plan: { name: 'Agence' }, usage: { sites: { active: 12, max: null } } }))],
  }, async (page) => {
    await page.run("T.until(() => T.visible('#plan-box'))");
    assert.match(await page.run("T.text('#plan-box')"), /Forfait Agence[\s\S]*12 sites surveillés · illimité/);
    assert.equal(await page.run("!!document.querySelector('#plan-box .gauge')"), false);
  });
  await withPage(t, {}, async (page) => {
    await page.run("T.until(() => document.querySelector('#plan-box'))");
    assert.equal(await page.run("T.visible('#plan-box')"), false, 'cœur auto-hébergé : aucune boîte de forfait');
  });
});

test('captures hors forfait : expliquées sur la fiche du site, sans « navigateur introuvable »', { skip, timeout: 90000 }, async (t) => {
  const w = await dbm.createWatch({ name: 'Sans captures', url: 'https://exemple.invalid/', interval: 60, config: { checks: { dns: false, tls: false, rdap: false } } });
  await withPage(t, { entitlements: { check() {}, limits: () => ({ screenshots: false }) } }, async (page) => {
    await page.run(`location.hash = '#/sites/${w.id}'`);
    await page.run("T.until(() => /Non incluses dans votre forfait/.test(document.body.textContent))");
    assert.ok(!/Navigateur introuvable/.test(await page.run('document.body.textContent')));
  });
});
