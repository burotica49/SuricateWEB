// Outil de test : ouvre une page dans un vrai Chrome (protocole DevTools) et y exécute du JavaScript.
// Volontairement indépendant de src/ (qui ouvrirait la base du projet à l'import).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].filter(Boolean);

export const findChrome = () => CANDIDATES.find((p) => existsSync(p)) || null;

/** Ouvre `url` et retourne { run(expression), close() }. `run` évalue (avec await) et retourne la valeur, ou lève l'exception de la page. */
export async function openPage(url, { width = 1280, height = 900 } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome introuvable');
  const profile = mkdtempSync(join(tmpdir(), 'suricate-e2e-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', `--window-size=${width},${height}`, 'about:blank'];
  if (/^(1|true)$/i.test(process.env.CHROME_NO_SANDBOX || '')) args.push('--no-sandbox');
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* déjà arrêté */ } };
  try {
    let log = '';
    const wsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Chrome ne démarre pas : ${log.slice(-200)}`)), 15000);
      child.stderr.on('data', (d) => { log += d; const m = /listening on (ws:\S+)/.exec(log); if (m) { clearTimeout(t); resolve(m[1]); } });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    const waiters = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } else waiters.slice().forEach((w) => w(m));
    });
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => send(m, p, sessionId);
    await S('Page.enable');
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const navigate = async (to) => {
      const loaded = new Promise((r) => { const w = (m) => { if (m.method === 'Page.loadEventFired') { waiters.splice(waiters.indexOf(w), 1); r(); } }; waiters.push(w); });
      await S('Page.navigate', { url: to });
      await Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]);
    };
    await navigate(url);
    return {
      navigate,
      async run(expression) {
        const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      /** Taille de la fenêtre (et densité de pixels) : sert aux captures de documentation. */
      async viewport(w, h, { dpr = 1, mobile = false } = {}) {
        await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
        // Un téléphone n'a ni survol ni souris : l'émulation tactile fait correspondre (hover: none) et (pointer: coarse).
        await S('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
      },
      /** Ajuste la hauteur de la fenêtre au contenu (bornée) : la barre latérale suit, et la capture n'est ni tronquée ni vide. */
      async fit(w, { min = 700, max = 2400, dpr = 1, mobile = false } = {}) {
        // On repart de la hauteur minimale : scrollHeight ne peut pas être inférieur à la fenêtre courante.
        await S('Emulation.setDeviceMetricsOverride', { width: w, height: min, deviceScaleFactor: dpr, mobile });
        for (let i = 0; i < 2; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const hgt = await this.run('document.documentElement.scrollHeight');
          await S('Emulation.setDeviceMetricsOverride', { width: w, height: Math.min(max, Math.max(min, hgt)), deviceScaleFactor: dpr, mobile });
          await new Promise((r) => setTimeout(r, 250));
        }
      },
      /** Capture PNG de la fenêtre, ou d'un élément (clipSelector). Retourne un Buffer. */
      async screenshot({ clipSelector, format = 'png' } = {}) {
        let clip;
        if (clipSelector) {
          const r = await this.run(`(() => { const b = document.querySelector(${JSON.stringify(clipSelector)}).getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height }; })()`);
          clip = { ...r, scale: 1 };
        }
        const shot = await S('Page.captureScreenshot', { format, ...(clip ? { clip, captureBeyondViewport: true } : {}) });
        return Buffer.from(shot.data, 'base64');
      },
      close() { try { ws.close(); } catch { /* ignoré */ } kill(); rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
    };
  } catch (e) {
    kill();
    rmSync(profile, { recursive: true, force: true });
    throw e;
  }
}
