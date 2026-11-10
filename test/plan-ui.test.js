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
    assert.equal(await page.run("document.querySelector('#plan-box').nextElementSibling?.classList.contains('tg-state')"), true, 'la boîte est calée juste au-dessus de l\'indicateur Telegram');
  });
});

test('liens propres à l\'utilisateur : ceux de la réponse de usageUrl (ex. « Administration ») s\'ajoutent à ceux des capacités, dangereux ignorés', { skip, timeout: 90000 }, async (t) => {
  const usage = { plan: { name: 'Agence' }, usage: { sites: { active: 1, total: 1, max: null } }, accountLinks: [{ label: 'Administration', href: '/api/account/pages/admin' }, { label: 'Piège', href: 'javascript:alert(1)' }, { label: 'Ailleurs', href: '//exemple.invalid/' }] };
  await withPage(t, {
    capabilities: { usageUrl: '/api/account/plan', accountLinks: [{ label: 'Mon forfait', href: '/api/account/pages/forfaits' }] },
    routes: [({ route }) => route('GET', '/api/account/plan', () => usage)],
  }, async (page) => {
    await page.run("T.until(() => T.visible('#plan-box') && document.querySelectorAll('#plan-box a').length >= 2)");
    const links = await page.run("[...document.querySelectorAll('#plan-box a')].map((a) => [a.textContent, a.getAttribute('href')])");
    assert.deepEqual(links, [['Mon forfait', '/api/account/pages/forfaits'], ['Administration', '/api/account/pages/admin']]);
  });
});

test('accès limité (invité) : liens du compte remplacés par ceux de l\'utilisateur, actions d\'écriture et Réglages cachés', { skip, timeout: 90000 }, async (t) => {
  const w = await dbm.createWatch({ name: 'Site partagé', url: 'https://exemple.invalid/', interval: 60, config: { checks: { dns: false, tls: false, rdap: false } } });
  const usage = { restricted: true, plan: { name: 'Agence' }, usage: null, accountLinks: [{ label: 'Compte : Agence Marie', href: '/api/account/pages/comptes' }] };
  await withPage(t, {
    capabilities: { usageUrl: '/api/account/plan', accountLinks: [{ label: 'Mon forfait', href: '/api/account/pages/forfaits' }], scopeLinks: [{ label: 'Notifications', href: '/api/account/pages/notifications', icon: 'bell' }] },
    routes: [({ route }) => route('GET', '/api/account/plan', () => usage)],
  }, async (page) => {
    await page.run("T.until(() => document.body.classList.contains('restricted') && T.visible('#plan-box'))");
    const links = await page.run("[...document.querySelectorAll('#plan-box a')].map((a) => a.textContent)");
    assert.deepEqual(links, ['Compte : Agence Marie'], 'pas « Mon forfait » : réservé au titulaire');
    const shown = (sel) => page.run(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null; })()`);
    assert.equal(await shown('[data-nav=reglages]'), false, 'pas de Réglages');
    assert.equal(await shown('.tg-state'), false, 'pas d\'indicateur Telegram');
    await page.run(`location.hash = '#/sites/${w.id}'`);
    await page.run("T.until(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Vérifier maintenant')))");
    const visible = (label) => page.run(`[...document.querySelectorAll('button, a')].some((b) => b.textContent.trim() === ${JSON.stringify(label)} && b.offsetParent !== null)`);
    assert.equal(await visible('Vérifier maintenant'), true, 'lire et lancer un contrôle restent possibles');
    for (const label of ['Modifier', 'Pause']) assert.equal(await visible(label), false, `« ${label} » caché`);
    assert.equal(await page.run("[...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Supprimer' && b.offsetParent !== null)"), false, 'suppression cachée');
    assert.equal(await visible('Notifications'), false, 'boutons par site cachés');
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
    assert.ok(!/null|undefined/.test(await page.run("T.text('#plan-box')")), 'jamais « null » affiché (forfait illimité : pas de barre, mais pas de texte parasite)');
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

test('boutons par groupe et par site : annoncés par le serveur (scopeLinks), réglés sur le bon groupe ou site, liens dangereux ignorés', { skip, timeout: 90000 }, async (t) => {
  const g = await dbm.createGroup({ name: 'Client Dupont' });
  const w = await dbm.createWatch({ name: 'Boutique', url: 'https://exemple.invalid/', interval: 60, groupId: g.id, config: { checks: { dns: false, tls: false, rdap: false } } });
  const scopeLinks = [
    { label: 'Notifications', href: '/api/account/pages/notifications', icon: 'bell' },
    { label: 'Partage', href: '/api/account/pages/partage?x=1', icon: 'share' },
    { label: 'Piège', href: 'javascript:alert(1)', icon: 'bell' },
    { label: 'Ailleurs', href: '//evil.example/', icon: 'bell' },
    { label: 'Icône inconnue', href: '/ok', icon: 'constructor' },
  ];
  await withPage(t, { capabilities: { scopeLinks } }, async (page) => {
    await page.run("T.until(() => document.querySelector('.grp-head'))");
    const grp = await page.run("[...document.querySelectorAll('.grp-actions a')].filter((a) => /scope=group/.test(a.getAttribute('href'))).map((a) => [a.getAttribute('href'), a.getAttribute('title')])");
    assert.deepEqual(grp, [
      [`/api/account/pages/notifications?scope=group&id=${g.id}`, 'Notifications de ce groupe'],
      [`/api/account/pages/partage?x=1&scope=group&id=${g.id}`, 'Partage de ce groupe'],
      [`/ok?scope=group&id=${g.id}`, 'Icône inconnue de ce groupe'],
    ], 'ni « javascript: » ni un autre site ; un paramètre existant est conservé');
    assert.equal(await page.run("document.querySelector('.grp-actions a[href*=\"scope=group\"] svg') !== null"), true, 'une icône, jamais de HTML venu du serveur');
    await page.run(`location.hash = '#/sites/${w.id}'`);
    await page.run("T.until(() => [...document.querySelectorAll('.actions a')].some((a) => /Notifications/.test(a.textContent)))");
    const site = await page.run("[...document.querySelectorAll('.actions a')].filter((a) => /scope=site/.test(a.getAttribute('href'))).map((a) => [a.textContent, a.getAttribute('href')])");
    assert.deepEqual(site, [
      ['Notifications', `/api/account/pages/notifications?scope=site&id=${w.id}`],
      ['Partage', `/api/account/pages/partage?x=1&scope=site&id=${w.id}`],
      ['Icône inconnue', `/ok?scope=site&id=${w.id}`],
    ]);
  });
  await withPage(t, {}, async (page) => {
    await page.run("T.until(() => document.querySelector('.grp-head'))");
    assert.equal(await page.run("document.querySelectorAll('.grp-actions a[href*=\"scope=\"]').length"), 0, 'cœur auto-hébergé : aucun bouton de ce genre');
  });
});

test('fréquences proposées selon le forfait : réglages, contrôle d\'un site et captures n\'offrent rien en dessous du minimum annoncé', { skip, timeout: 90000 }, async (t) => {
  const w = await dbm.createWatch({ name: 'Fréquences', url: 'https://exemple.invalid/', interval: 15, config: { checks: { dns: false, tls: false, rdap: false }, screenshot: { enabled: true, interval: 5 } } });
  const usage = { plan: { name: 'Perso', limits: { minIntervalMin: 60 } }, usage: { sites: { active: 1, total: 1, max: 5 } } };
  const options = (label) => `(() => { const f = [...document.querySelectorAll('.field')].find((x) => x.querySelector('label')?.textContent === ${JSON.stringify(label)}); const s = f?.querySelector('select'); return s ? { values: [...s.options].map((o) => Number(o.value)), value: Number(s.value) } : null; })()`;
  await withPage(t, {
    capabilities: { usageUrl: '/api/account/plan' },
    routes: [({ route }) => route('GET', '/api/account/plan', () => usage)],
    entitlements: { check() {}, limits: () => ({ minIntervalMin: 60 }) },
  }, async (page) => {
    await page.run("T.until(() => T.visible('#plan-box'))"); // le forfait est connu de l'interface

    // Réglages : « Fréquence par défaut » (15 min enregistrées par défaut, ramenées à 60 min).
    await page.run("location.hash = '#/reglages'");
    await page.run(`T.until(() => ${options('Fréquence par défaut')})`);
    const def = await page.run(options('Fréquence par défaut'));
    assert.ok(def.values.every((v) => v >= 60), `rien sous 60 min : ${def.values}`);
    assert.equal(def.value, 60, 'la valeur affichée est celle qui sera réellement appliquée');

    // Fiche du site › Modifier : « Fréquence de contrôle » et, dans « Capture d'écran », « Fréquence ».
    await page.run(`location.hash = '#/sites/${w.id}'`);
    await page.run("T.until(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Modifier'))");
    await page.run("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Modifier').click()");
    await page.run(`T.until(() => ${options('Fréquence de contrôle')})`);
    const check = await page.run(options('Fréquence de contrôle'));
    assert.ok(check.values.every((v) => v >= 60), `contrôle : rien sous 60 min : ${check.values}`);
    assert.equal(check.value, 60);
    const shot = await page.run(options('Fréquence'));
    assert.ok(shot.values.every((v) => v >= 60), `capture : rien sous 60 min : ${shot.values}`);
    assert.equal(shot.value, 60);
  });
});

test('sans forfait annoncé (cœur auto-hébergé) : toutes les fréquences restent proposées', { skip, timeout: 90000 }, async (t) => {
  await withPage(t, {}, async (page) => {
    await page.run("location.hash = '#/reglages'");
    await page.run("T.until(() => [...document.querySelectorAll('.field')].some((x) => x.querySelector('label')?.textContent === 'Fréquence par défaut'))");
    const values = await page.run("[...[...document.querySelectorAll('.field')].find((x) => x.querySelector('label')?.textContent === 'Fréquence par défaut').querySelector('select').options].map((o) => Number(o.value))");
    assert.ok(values.includes(1) && values.includes(5) && values.includes(15), `choix complets : ${values}`);
    assert.ok(!/Notifications par e-mail/.test(await page.run('document.body.textContent')), 'sans capacité emailAlerts : pas de section e-mail');
  });
});

test('Réglages › Notifications par e-mail : annoncée par le serveur (emailAlerts), enregistrée avec la page, testée, lien « plus » du même site seulement', { skip, timeout: 90000 }, async (t) => {
  const state = { address: 'marie@exemple.fr', enabled: false, minSeverity: 'warning', sendRecovery: true, lastSentAt: null, lastError: null };
  const calls = [];
  await withPage(t, {
    capabilities: { emailAlerts: { url: '/api/account/email-alerts', moreUrl: '/api/account/pages/notifications' } },
    routes: [({ route }) => {
      route('GET', '/api/account/email-alerts', () => state);
      route('PUT', '/api/account/email-alerts', (ctx) => { calls.push(['PUT', ctx.body]); Object.assign(state, ctx.body); return state; });
      route('POST', '/api/account/email-alerts/test', () => { calls.push(['TEST']); return { ok: true }; });
    }],
  }, async (page) => {
    await page.run("location.hash = '#/reglages'");
    await page.run("T.until(() => /Notifications par e-mail/.test(document.body.textContent))");
    const section = "[...document.querySelectorAll('section')].find((x) => x.querySelector('h2')?.textContent === 'Notifications par e-mail')";
    assert.match(await page.run(`${section}.textContent`), /marie@exemple\.fr, l'adresse de votre compte/);
    assert.equal(await page.run(`${section}.querySelector('input[type=checkbox]').checked`), false, 'désactivé tant qu\'on ne l\'a pas demandé');
    assert.deepEqual(await page.run(`[...${section}.querySelectorAll('a')].map((a) => a.getAttribute('href'))`), ['/api/account/pages/notifications']);

    // Cocher puis enregistrer la page : la section part avec le reste des réglages.
    await page.run(`${section}.querySelector('input[type=checkbox]').click()`);
    await page.run("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Enregistrer').click()");
    await page.run('T.until(() => true)');
    for (let i = 0; i < 50 && !calls.some((c) => c[0] === 'PUT'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(calls.find((c) => c[0] === 'PUT')[1], { enabled: true, sendRecovery: true, minSeverity: 'warning' });

    // « Tester » : enregistre d'abord, puis envoie le message de test.
    calls.length = 0;
    await page.run("location.hash = '#/alertes'");
    await page.run("location.hash = '#/reglages'");
    await page.run("T.until(() => /Notifications par e-mail/.test(document.body.textContent))");
    await page.run(`${section}.querySelector('select').value = 'critical'`);
    await page.run(`[...${section}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Tester').click()`);
    for (let i = 0; i < 50 && !calls.some((c) => c[0] === 'TEST'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(calls.map((c) => c[0]), ['PUT', 'TEST']);
    assert.equal(calls[0][1].minSeverity, 'critical');
  });
});
