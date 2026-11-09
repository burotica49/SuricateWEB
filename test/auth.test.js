import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readCredentials, checkLogin, sessionKey } from '../src/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ───────────── Unitaire ─────────────

test('identifiants : obligatoires, 8 caractères minimum, identifiant « admin » par défaut', () => {
  assert.match(readCredentials({}).error, /SURICATE_PASSWORD/);
  assert.match(readCredentials({ SURICATE_USER: 'x' }).error, /SURICATE_PASSWORD/, 'un identifiant seul ne protège rien');
  assert.match(readCredentials({ SURICATE_PASSWORD: 'court' }).error, /8 caractères/);
  assert.deepEqual(readCredentials({ SURICATE_PASSWORD: 'longenough' }), { user: 'admin', password: 'longenough', defaultedUser: true });
  assert.deepEqual(readCredentials({ SURICATE_USER: ' boss ', SURICATE_PASSWORD: 'longenough' }), { user: 'boss', password: 'longenough', defaultedUser: false });
});

test('checkLogin : identifiant ET mot de passe exacts', () => {
  const c = { user: 'boss', password: 'Sup3r-secret' };
  assert.equal(checkLogin(c, 'boss', 'Sup3r-secret'), true);
  assert.equal(checkLogin(c, ' boss ', 'Sup3r-secret'), true, "espaces autour de l'identifiant ignorés");
  assert.equal(checkLogin(c, 'Boss', 'Sup3r-secret'), false, 'identifiant sensible à la casse');
  assert.equal(checkLogin(c, 'boss', 'sup3r-secret'), false);
  assert.equal(checkLogin(c, 'boss', 'Sup3r-secret '), false, 'le mot de passe est comparé tel quel');
  assert.equal(checkLogin(c, undefined, undefined), false);
  assert.equal(checkLogin(c, '', ''), false);
  assert.notEqual(sessionKey(c, 's'), sessionKey({ ...c, password: 'Autre-mdp1' }, 's'), 'changer le mot de passe invalide les sessions');
});

// ───────────── Serveur réel ─────────────

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/** Lance server.js avec un environnement maîtrisé (aucun SURICATE_* hérité du poste). */
async function start({ envFile, env = {}, dataDir = mkdtempSync(join(tmpdir(), 'suricate-auth-')) } = {}) {
  const port = await freePort();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SURICATE_|DATA_DIR|PORT|HOST|ENV_FILE|TRUST_PROXY)/.test(k)));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
    env: { ...clean, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ENV_FILE: envFile || join(dataDir, 'absent.env'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  const ready = await Promise.race([
    exited.then(() => false),
    (async () => {
      for (let i = 0; i < 80; i++) {
        try { await fetch(`${base}/api/auth`); return true; } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      return false;
    })(),
  ]);
  const api = (path, { body, cookie, headers } = {}) => fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ready, exited, out: () => out, api, base, dataDir, stop: async () => { proc.kill(); await exited; } };
}

const writeEnv = (content) => {
  const f = join(mkdtempSync(join(tmpdir(), 'suricate-env-')), '.env');
  writeFileSync(f, content);
  return f;
};
const loginCookie = async (srv, username, password) => {
  const r = await srv.api('/api/login', { body: { username, password } });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] };
};

test('sans identifiants : le serveur refuse de démarrer', async () => {
  const srv = await start();
  assert.equal(srv.ready, false);
  assert.equal(await srv.exited, 1);
  assert.match(srv.out(), /SURICATE_PASSWORD/);
  assert.match(srv.out(), /\.env/);
});

test('mot de passe trop court : refus de démarrer', async () => {
  const srv = await start({ envFile: writeEnv('SURICATE_USER=boss\nSURICATE_PASSWORD=court\n') });
  assert.equal(srv.ready, false);
  assert.equal(await srv.exited, 1);
  assert.match(srv.out(), /8 caractères/);
});

test('.env : identifiants lus, API protégée, connexion, session', async () => {
  // Guillemets et « # » dans le mot de passe : cas classique qui casse un .env mal parsé.
  const srv = await start({ envFile: writeEnv('# commentaire\nSURICATE_USER=boss\nSURICATE_PASSWORD="pa ss#word-Solide1"\n') });
  try {
    assert.equal(srv.ready, true, srv.out());
    assert.match(srv.out(), /identifiant « boss »/);
    assert.doesNotMatch(srv.out(), /pa ss#word/, 'le mot de passe ne doit jamais apparaître dans les journaux');

    assert.deepEqual(await (await srv.api('/api/auth')).json(), { required: true, authenticated: false });
    for (const p of ['/api/watches', '/api/settings', '/api/alerts', '/api/export', '/api/events', '/api/screenshots/1/image']) {
      assert.equal((await srv.api(p)).status, 401, `${p} doit être protégé`);
    }
    assert.equal((await srv.api('/')).status, 200, 'la page de connexion (statique) reste accessible');
    assert.equal((await srv.api('/app.js')).status, 200);

    assert.equal((await loginCookie(srv, 'boss', 'mauvais')).status, 401, 'mauvais mot de passe');
    assert.equal((await loginCookie(srv, 'autre', 'pa ss#word-Solide1')).status, 401, 'mauvais identifiant');
    assert.equal((await loginCookie(srv, '', '')).status, 401);
    assert.equal((await srv.api('/api/login', { body: {} })).status, 401);

    const ok = await loginCookie(srv, 'boss', 'pa ss#word-Solide1');
    assert.equal(ok.status, 200);
    assert.match(ok.cookie, /^suricate_session=/);
    assert.equal((await srv.api('/api/watches', { cookie: ok.cookie })).status, 200);
    assert.equal((await srv.api('/api/watches', { cookie: ok.cookie.slice(0, -3) + 'xyz' })).status, 401, 'cookie falsifié');
    assert.equal((await (await srv.api('/api/settings', { cookie: ok.cookie })).json()).authUser, 'boss');
    assert.equal(JSON.stringify(await (await srv.api('/api/settings', { cookie: ok.cookie })).json()).includes('Solide1'), false);
    assert.equal((await srv.api('/api/settings/password', { body: { password: 'x' }, cookie: ok.cookie })).status, 404, "plus de changement de mot de passe depuis l'interface");

    const setCookie = (await srv.api('/api/login', { body: { username: 'boss', password: 'pa ss#word-Solide1' } })).headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Secure/, 'pas de Secure en HTTP direct');
  } finally {
    await srv.stop();
  }
});

test('changer le mot de passe invalide les sessions existantes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'suricate-auth-'));
  const a = await start({ dataDir, envFile: writeEnv('SURICATE_USER=boss\nSURICATE_PASSWORD=ancien-mdp-1\n') });
  const { cookie } = await loginCookie(a, 'boss', 'ancien-mdp-1');
  assert.equal((await a.api('/api/watches', { cookie })).status, 200);
  await a.stop();

  const b = await start({ dataDir, envFile: writeEnv('SURICATE_USER=boss\nSURICATE_PASSWORD=nouveau-mdp-2\n') });
  try {
    assert.equal((await b.api('/api/watches', { cookie })).status, 401, "l'ancienne session ne doit plus être valide");
    assert.equal((await loginCookie(b, 'boss', 'ancien-mdp-1')).status, 401);
    assert.equal((await loginCookie(b, 'boss', 'nouveau-mdp-2')).status, 200);
  } finally {
    await b.stop();
  }
});

test('variables d\'environnement prioritaires sur .env ; identifiant par défaut « admin »', async () => {
  const srv = await start({ envFile: writeEnv('SURICATE_USER=depuis-fichier\nSURICATE_PASSWORD=depuis-fichier-1\n'), env: { SURICATE_USER: '', SURICATE_PASSWORD: 'depuis-docker-22' } });
  try {
    assert.equal(srv.ready, true, srv.out());
    assert.equal((await loginCookie(srv, 'depuis-fichier', 'depuis-fichier-1')).status, 401, 'le .env ne doit pas écraser les variables déjà définies');
    assert.equal((await loginCookie(srv, 'admin', 'depuis-docker-22')).status, 200, 'SURICATE_USER vide → « admin »');
    assert.match(srv.out(), /SURICATE_USER n'est pas défini/);
  } finally {
    await srv.stop();
  }
});

test('.env : DATA_DIR est pris en compte (chargé avant la base)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'suricate-data-'));
  const srv = await start({ envFile: writeEnv(`SURICATE_PASSWORD=motdepasse-ok1\nDATA_DIR=${dataDir}\n`), env: { DATA_DIR: undefined }, dataDir: mkdtempSync(join(tmpdir(), 'suricate-unused-')) });
  try {
    assert.equal(srv.ready, true, srv.out());
    assert.equal(existsSync(join(dataDir, 'suricate.db')), true);
  } finally {
    await srv.stop();
  }
});

test('limitation des tentatives de connexion (429 après 5 essais)', async () => {
  const srv = await start({ envFile: writeEnv('SURICATE_USER=boss\nSURICATE_PASSWORD=motdepasse-ok1\n') });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await loginCookie(srv, 'boss', 'faux-' + i)).status, 401);
    assert.equal((await loginCookie(srv, 'boss', 'faux-6')).status, 429);
    assert.equal((await loginCookie(srv, 'boss', 'motdepasse-ok1')).status, 429, 'même le bon mot de passe est bloqué pendant la minute');
  } finally {
    await srv.stop();
  }
});

test('derrière un proxy HTTPS : cookie Secure, et limitation par IP réelle', async () => {
  const srv = await start({ envFile: writeEnv('SURICATE_USER=boss\nSURICATE_PASSWORD=motdepasse-ok1\n'), env: { TRUST_PROXY: '1' } });
  try {
    const r = await srv.api('/api/login', { body: { username: 'boss', password: 'motdepasse-ok1' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' } });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
    // L'IP d'un autre visiteur n'est pas bloquée par les essais d'une IP voisine.
    for (let i = 0; i < 6; i++) await srv.api('/api/login', { body: { username: 'x', password: 'y' }, headers: { 'x-forwarded-for': '198.51.100.1' } });
    const other = await srv.api('/api/login', { body: { username: 'boss', password: 'motdepasse-ok1' }, headers: { 'x-forwarded-for': '203.0.113.50' } });
    assert.equal(other.status, 200);
  } finally {
    await srv.stop();
  }
});
