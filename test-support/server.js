// Outils de test : lance server.js en sous-processus avec un environnement maîtrisé, et un client HTTP minimal.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/** Démarre le serveur (aucune variable VIGIE_* héritée du poste). Retourne un client déjà connecté si `login` est vrai. */
export async function startServer({ user = 'boss', password = 'motdepasse-test-1', dataDir = mkdtempSync(join(tmpdir(), 'vigie-srv-')), env = {} } = {}) {
  const port = await freePort();
  const envFile = join(dataDir, '.env');
  writeFileSync(envFile, `VIGIE_USER=${user}\nVIGIE_PASSWORD="${password}"\n`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VIGIE_|DATA_DIR|PORT|HOST|ENV_FILE|TRUST_PROXY|CHROME_PATH)/.test(k)));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
    // CHROME_PATH vers un chemin inexistant : aucune capture (Chrome) ne démarre pendant ces tests.
    env: { ...clean, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ENV_FILE: envFile, CHROME_PATH: '/nonexistent/chrome', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => proc.on('exit', r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/auth`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    if (i === 99) throw new Error(`Le serveur ne démarre pas :\n${out}`);
  }
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* corps non JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async () => {
    const r = await call('POST', '/api/login', { username: user, password });
    cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    return r.status;
  };
  await login();
  return {
    base, dataDir, call, login, logout: () => { cookie = ''; },
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b = {}) => call('PUT', p, b), del: (p) => call('DELETE', p),
    stop: async () => { proc.kill(); await exited; },
  };
}
