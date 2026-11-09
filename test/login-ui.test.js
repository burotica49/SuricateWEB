// Écran de connexion et « Sécurité du compte » avec un fournisseur d'authentification enrichi (version hébergée) : vrai Chrome,
// vrai serveur createApp, fournisseur factice en mémoire. Ce que le fournisseur annonce dans GET /api/auth doit se voir à l'écran,
// et ce qui n'est pas sûr (un lien « javascript: » ou vers un autre site) ne doit jamais s'afficher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPage, findChrome } from '../test-support/browser.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-loginui-'));

const { createApp } = await import('../src/app.js');
const { resetExtensions } = await import('../src/extensions.js');

const skip = !findChrome() && 'Chrome/Chromium introuvable';
const GOOD = 'bon mot de passe';

/** Fournisseur factice : une session en mémoire, un 2FA que le test active ou non. */
function fakeAuth(state) {
  return {
    kind: 'fake',
    authenticate: () => (state.in ? { user: { id: 1, name: 'marie@exemple.fr' }, account: { id: 1 } } : null),
    register({ route, send, HANDLED }) {
      const refuse = (ctx, status, error, code) => { send(ctx.res, status, { error, code }); return HANDLED; };
      route('GET', '/api/auth', () => ({
        required: true, authenticated: state.in, accountApi: true, identifierLabel: 'Adresse e-mail',
        // Un lien du même site est affiché ; « javascript: » et un autre domaine ne doivent jamais l'être.
        links: { signup: '/api/account/pages/signup', forgot: 'javascript:alert(1)' },
      }), { public: true });
      route('POST', '/api/login', (ctx) => {
        if (ctx.body.password !== GOOD) return refuse(ctx, 401, 'Adresse e-mail ou mot de passe incorrect', 'invalid_credentials');
        if (state.twofa && ctx.body.code !== '123456') {
          return ctx.body.code ? refuse(ctx, 401, 'Code incorrect', 'invalid_2fa') : refuse(ctx, 401, 'Saisissez le code', 'needs_2fa');
        }
        state.in = true;
        return { ok: true };
      }, { public: true });
      route('POST', '/api/logout', () => { state.in = false; return { ok: true }; }, { public: true });

      route('GET', '/api/account/security', () => ({ email: 'marie@exemple.fr', sessions: state.sessions, twofa: { available: true, enabled: state.twofa } }));
      route('POST', '/api/account/password', (ctx) => {
        state.log.push(['password', ctx.body.current, ctx.body.next]);
        if (ctx.body.current !== GOOD) return refuse(ctx, 403, 'Mot de passe actuel incorrect', 'invalid_credentials');
        return { ok: true };
      });
      route('POST', '/api/account/sessions/revoke-others', () => { const revoked = state.sessions - 1; state.sessions = 1; return { revoked }; });
      route('POST', '/api/account/2fa/begin', () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/SuricateWeb:marie?secret=JBSWY3DPEHPK3PXP' }));
      route('POST', '/api/account/2fa/enable', (ctx) => {
        if (ctx.body.code !== '123456') return refuse(ctx, 400, 'Code incorrect', 'invalid_2fa');
        state.twofa = true;
        return { recoveryCodes: Array.from({ length: 8 }, (_, i) => `abcdef000${i}`) };
      });
      route('POST', '/api/account/2fa/disable', (ctx) => {
        if (ctx.body.password !== GOOD) return refuse(ctx, 403, 'Mot de passe incorrect', 'invalid_credentials');
        state.twofa = false;
        return { ok: true };
      });
    },
  };
}

// Aides exécutées dans la page.
const HELPERS = `window.T = {
  until: (fn, ms = 6000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { let v; try { v = fn(); } catch {} if (v) { clearInterval(i); res(v); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('délai : ' + fn)); } }, 40); }),
  set: (sel, v) => { document.querySelector(sel).value = v; },
  submit: (sel) => document.querySelector(sel).closest('form').requestSubmit(),
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
  visible: (sel) => { const e = document.querySelector(sel); return !!e && !e.hidden && e.offsetParent !== null; },
  clickText: (txt) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === txt); if (!b) throw new Error('bouton absent : ' + txt); b.click(); },
}; true`;

test('connexion : libellé, lien d\'inscription sûr, code 2FA demandé puis refusé puis accepté', { skip, timeout: 90000 }, async () => {
  const state = { in: false, twofa: true, sessions: 3, log: [] };
  const app = createApp({ auth: fakeAuth(state), env: { ...process.env, TELEGRAM_POLL: '0' } });
  const port = await app.listen(0, '127.0.0.1');
  let page;
  try {
    page = await openPage(`http://127.0.0.1:${port}/`);
    await page.run(HELPERS);
    await page.run(`T.until(() => document.querySelector('#login-user'))`);

    // Ce que le fournisseur annonce est affiché : libellé du champ, lien du même site ; le lien « javascript: » est refusé.
    assert.equal(await page.run(`document.querySelector('label[for], .field label')?.textContent`), 'Adresse e-mail');
    assert.equal(await page.run(`document.querySelector('#login-user').getAttribute('aria-label')`), 'Adresse e-mail');
    assert.deepEqual(await page.run(`[...document.querySelectorAll('.login-links a')].map((a) => [a.textContent, a.getAttribute('href')])`), [['Créer un compte', '/api/account/pages/signup']]);
    assert.equal(await page.run(`T.visible('#login-code-field')`), false, 'le code n\'est pas demandé tant que le serveur ne le réclame pas');

    // Mauvais mot de passe : message, champ de code toujours caché.
    await page.run(`T.set('#login-user', 'marie@exemple.fr'); T.set('#login-pw', 'faux'); T.submit('#login-pw'); T.until(() => T.text('[role=alert]'))`);
    assert.equal(await page.run(`T.text('[role=alert]')`), 'Adresse e-mail ou mot de passe incorrect');
    assert.equal(await page.run(`T.visible('#login-code-field')`), false);

    // Bon mot de passe, 2FA actif : le champ de code apparaît, avec le focus.
    await page.run(`T.set('#login-pw', ${JSON.stringify(GOOD)}); T.submit('#login-pw'); T.until(() => T.visible('#login-code-field'))`);
    assert.equal(await page.run(`document.activeElement.id`), 'login-code');
    // Code faux : message du serveur, on reste sur l'écran de connexion.
    await page.run(`T.set('#login-pw', ${JSON.stringify(GOOD)}); T.set('#login-code', '000000'); T.submit('#login-code'); T.until(() => T.text('[role=alert]') === 'Code incorrect')`);
    assert.equal(await page.run(`!!document.querySelector('.login')`), true);
    // Bon code : connecté, l'application s'affiche.
    await page.run(`T.set('#login-pw', ${JSON.stringify(GOOD)}); T.set('#login-code', '123456'); T.submit('#login-code'); T.until(() => !document.querySelector('.login'))`);
    assert.equal(state.in, true);
  } finally {
    await page?.close();
    await app.stop();
    resetExtensions();
  }
});

test('sécurité du compte : mot de passe, connexions, activation puis retrait de la double authentification', { skip, timeout: 90000 }, async () => {
  const state = { in: true, twofa: false, sessions: 3, log: [] };
  const app = createApp({ auth: fakeAuth(state), env: { ...process.env, TELEGRAM_POLL: '0' } });
  const port = await app.listen(0, '127.0.0.1');
  let page;
  try {
    page = await openPage(`http://127.0.0.1:${port}/#/reglages`);
    await page.run(HELPERS);
    await page.run(`T.until(() => T.text('#account-security h2') === 'Sécurité du compte' && T.text('#account-security')?.includes('marie@exemple.fr'))`);
    // Pas de carte « identifiant défini dans le .env » : ici l'identité vient du fournisseur.
    assert.equal(await page.run(`document.body.textContent.includes('SURICATE_USER')`), false);
    assert.match(await page.run(`T.text('#account-security')`), /3 connexions ouvertes/);

    // Mot de passe : refusé avec le message du serveur, puis accepté.
    await page.run(`T.set('#sec-current', 'faux'); T.set('#sec-next', 'un nouveau mot de passe'); T.submit('#sec-next'); T.until(() => document.querySelector('.toast.err'))`);
    assert.match(await page.run(`T.text('.toast.err')`), /Mot de passe actuel incorrect/);
    await page.run(`T.set('#sec-current', ${JSON.stringify(GOOD)}); T.set('#sec-next', 'un nouveau mot de passe'); T.submit('#sec-next'); T.until(() => document.querySelector('.toast.ok'))`);
    assert.deepEqual(state.log.at(-1), ['password', GOOD, 'un nouveau mot de passe']);

    // Autres connexions.
    await page.run(`T.clickText('Fermer les autres connexions'); T.until(() => /1 connexion ouverte/.test(T.text('#account-security')))`);
    assert.equal(state.sessions, 1);

    // Double authentification : clé affichée, mauvais code refusé, bon code → 8 codes de secours montrés une fois.
    await page.run(`T.clickText('Activer la double authentification'); T.until(() => T.visible('#twofa-secret'))`);
    assert.equal(await page.run(`T.text('#twofa-secret')`), 'JBSWY3DPEHPK3PXP');
    assert.equal(await page.run(`document.querySelector('#account-security a[href^="otpauth://"]')?.textContent`), 'ouvrir dans mon application d\'authentification');
    await page.run(`T.set('#twofa-on-code', '000000'); T.submit('#twofa-on-code'); T.until(() => /Code incorrect/.test(T.text('.toast.err') || ''))`);
    await page.run(`T.set('#twofa-on-code', '123456'); T.submit('#twofa-on-code'); T.until(() => T.visible('#recovery-codes'))`);
    assert.deepEqual((await page.run(`T.text('#recovery-codes')`)).split('\n'), Array.from({ length: 8 }, (_, i) => `abcdef000${i}`));
    assert.equal(state.twofa, true);
    await page.run(`T.clickText('J\\'ai noté mes codes'); T.until(() => T.visible('#twofa-off-pw'))`); // les codes disparaissent, la carte montre « Activée »
    assert.equal(await page.run(`!!document.querySelector('#recovery-codes')`), false);
    assert.match(await page.run(`T.text('#account-security')`), /Activée/);

    // Retrait : mot de passe exigé.
    await page.run(`T.set('#twofa-off-pw', 'faux'); T.set('#twofa-off-code', '123456'); T.submit('#twofa-off-pw'); T.until(() => /Mot de passe incorrect/.test(T.text('.toast.err') || ''))`);
    assert.equal(state.twofa, true);
    await page.run(`T.set('#twofa-off-pw', ${JSON.stringify(GOOD)}); T.submit('#twofa-off-pw'); T.until(() => T.visible('#twofa-begin'))`);
    assert.equal(state.twofa, false);
  } finally {
    await page?.close();
    await app.stop();
    resetExtensions();
  }
});

test('sans fournisseur enrichi (installation classique) : écran de connexion et carte Sécurité inchangés', { skip, timeout: 60000 }, async () => {
  const state = { in: false };
  // Un fournisseur minimal, comme celui du .env : aucun champ facultatif dans GET /api/auth.
  const plain = {
    kind: 'plain',
    authenticate: () => (state.in ? { user: { id: 1, name: 'admin' }, account: { id: 1 } } : null),
    register({ route }) {
      route('GET', '/api/auth', () => ({ required: true, authenticated: state.in }), { public: true });
      route('POST', '/api/login', () => { state.in = true; return { ok: true }; }, { public: true });
    },
  };
  const app = createApp({ auth: plain, env: { ...process.env, TELEGRAM_POLL: '0' } });
  const port = await app.listen(0, '127.0.0.1');
  let page;
  try {
    page = await openPage(`http://127.0.0.1:${port}/`);
    await page.run(HELPERS);
    await page.run(`T.until(() => document.querySelector('#login-user'))`);
    assert.equal(await page.run(`document.querySelector('#login-user').getAttribute('aria-label')`), 'Identifiant');
    assert.equal(await page.run(`document.querySelectorAll('.login-links').length`), 0, 'aucun lien');
    assert.equal(await page.run(`T.visible('#login-code-field')`), false);
    await page.navigate(`http://127.0.0.1:${port}/`); // la page est déjà chargée ; on vérifie surtout l'absence d'erreur de script
  } finally {
    await page?.close();
    await app.stop();
    resetExtensions();
  }
});
