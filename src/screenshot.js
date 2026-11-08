// Captures d'écran : on pilote Chrome/Chromium directement via le protocole DevTools (WebSocket natif de Node).
// Aucune dépendance npm. Un navigateur neuf (profil jetable) est lancé pour chaque capture puis détruit : pas d'état
// partagé entre sites, pas de cookie qui traîne, pas de processus orphelin.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, unlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWatch, listWatches, getSettings, SHOTS_DIR, insertScreenshot, setShotState, screenshotsToPrune, deleteScreenshotRows } from './db.js';
import { bus } from './events.js';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

let chromeCache;
export const chromePath = () => (chromeCache ??= CANDIDATES.find((p) => existsSync(p)) || null);

export const NO_CHROME = "Chrome ou Chromium est introuvable sur le serveur : installez-le, ou indiquez son chemin dans CHROME_PATH.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attend `p` au plus `ms` ; ne rejette jamais (retourne null) et annule son minuteur dès que `p` a répondu. */
const withTimeout = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
});

// ───────────── Client DevTools minimal ─────────────

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      } else for (const l of [...this.listeners]) l(m);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Le navigateur a fermé la connexion'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Attend un évènement ; à appeler AVANT l'action qui le provoque. La promesse a une méthode cancel() :
   * si on quitte avant l'évènement (navigation en erreur), il faut l'annuler, sinon son délai expire plus tard
   * et le rejet non géré ferait tomber tout le processus.
   */
  once(method, sessionId, ms) {
    let cancel;
    const p = new Promise((resolve, reject) => {
      const off = this.on((m) => {
        if (m.method === method && m.sessionId === sessionId) {
          cancel();
          resolve(m.params);
        }
      });
      const t = setTimeout(() => {
        off();
        reject(new Error('timeout'));
      }, ms);
      cancel = () => {
        clearTimeout(t);
        off();
      };
    });
    p.cancel = cancel;
    p.catch(() => {}); // aucun « unhandledRejection » même si personne n'attend le résultat
    return p;
  }
}

const FRIENDLY = [
  [/ERR_NAME_NOT_RESOLVED/, 'Nom de domaine introuvable (DNS)'],
  [/ERR_CONNECTION_REFUSED/, 'Connexion refusée par le serveur'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'Délai de connexion dépassé'],
  [/ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/, 'Connexion interrompue par le serveur'],
  [/ERR_CERT_DATE_INVALID/, 'Certificat TLS expiré'],
  [/ERR_CERT_/, 'Certificat TLS invalide'],
  [/ERR_TOO_MANY_REDIRECTS/, 'Boucle de redirections'],
  [/ERR_UNSAFE_PORT/, 'Port bloqué par le navigateur (liste de ports réservés de Chrome)'],
  [/ERR_INVALID_URL|ERR_ABORTED/, 'Adresse refusée par le navigateur'],
  [/ERR_SSL_/, 'Erreur de protocole TLS'],
];
const friendly = (m) => FRIENDLY.find(([re]) => re.test(m))?.[1] || m;

/** Sélecteurs des bandeaux de cookies courants (Complianz, Cookiebot, OneTrust, Axeptio, Didomi, Tarteaucitron, CookieYes…). */
const COOKIE_BANNERS = [
  '#cmplz-cookiebanner-container', '.cmplz-cookiebanner', '.cmplz-soft-cookiewall',
  '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',
  '#onetrust-consent-sdk', '#onetrust-banner-sdk',
  '#axeptio_overlay', '#axeptio_main_button',
  '#didomi-host', '.didomi-popup-container',
  '#tarteaucitronRoot', '#tarteaucitronAlertBig',
  '.cky-consent-container', '.cky-overlay', '.cky-modal',
  '#cookie-law-info-bar', '#cookie-notice', '.cookie-notice-container',
  '#moove_gdpr_cookie_info_bar', '.moove-gdpr-info-bar-container',
  '#usercentrics-root', '.iubenda-cs-container', '#iubenda-cs-banner',
  '.osano-cm-window', '.cc-window', '.cc-banner', '#cookiescript_injected',
  '#sp_message_container_1', '.qc-cmp2-container', '.fc-consent-root',
  '#gdpr-cookie-message', '#cookie-banner', '.cookie-banner', '#cookieConsent', '#cookie-consent', '.cookie-consent',
].join(', ');

/**
 * Script exécuté dans la page : désactive le chargement différé natif, descend la page par paliers (comme un
 * visiteur), remonte en haut, puis attend les polices. Retourne la hauteur finale du document.
 */
const scrollThroughScript = (limit) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((e) => { e.loading = 'eager'; });
  const vh = window.innerHeight;
  const step = Math.max(200, Math.round(vh * 0.6));
  let y = 0;
  // la hauteur peut croître pendant le défilement (contenu qui se charge) : on la relit à chaque palier
  while (y < Math.min(document.documentElement.scrollHeight - vh, ${limit})) {
    y += step;
    window.scrollTo(0, y);
    await sleep(220);
  }
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event('scroll'));
  await sleep(350);
  try { await Promise.race([document.fonts.ready, sleep(3000)]); } catch (e) {}
  return document.documentElement.scrollHeight;
})()`;

/**
 * Capture `url`. Retourne { image, thumb, width, height } (JPEG). Lève une Error au message lisible.
 * Le navigateur est toujours tué, même en cas de page bloquée : plafond de durée global.
 * `settleMs` : pause finale après chargement et défilement (animations, sliders).
 * `interact` : simule un visiteur (souris, molette) pour réveiller les scripts « retardés jusqu'à l'interaction ».
 * `hideBanners` : masque les bandeaux de consentement aux cookies les plus courants.
 */
export async function capture(url, { width = 1280, height = 800, fullPage = false, timeoutMs = 30000, settleMs = 3000, interact = true, hideBanners = true, quality = 72, headers, userAgent } = {}) {
  const bin = chromePath();
  if (!bin) throw new Error(NO_CHROME);
  const profile = await mkdtemp(join(tmpdir(), 'vigie-chrome-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-breakpad',
    '--disable-features=Translate,MediaRouter,OptimizationHints', 'about:blank',
  ];
  // Le bac à sable de Chrome exige des privilèges que Docker n'accorde pas : à n'activer que dans un conteneur.
  if (/^(1|true|yes)$/i.test(process.env.CHROME_NO_SANDBOX || '')) args.push('--no-sandbox');

  const win = process.platform === 'win32';
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: !win });
  const kill = () => {
    try {
      if (win) child.kill();
      else process.kill(-child.pid, 'SIGKILL'); // tout le groupe : processus de rendu compris
    } catch { /* déjà terminé */ }
  };
  let stderr = '';
  const hardStop = setTimeout(kill, timeoutMs + 25000);
  let ws;
  let loaded;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Le navigateur ne démarre pas${stderr ? ` : ${stderr.trim().split('\n').pop().slice(0, 160)}` : ''}`)), 15000);
      child.stderr.on('data', (d) => {
        stderr += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.on('error', (e) => { clearTimeout(t); reject(new Error(`Lancement du navigateur impossible : ${e.message}`)); });
      child.on('exit', (code) => { clearTimeout(t); reject(new Error(`Le navigateur s'est arrêté (code ${code})${stderr ? ` : ${stderr.trim().split('\n').pop().slice(0, 160)}` : ''}`)); });
    });

    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('Connexion au navigateur impossible')), { once: true });
    });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => cdp.send(method, params, sessionId);
    await S('Page.enable');
    await S('Network.enable');

    // « HeadlessChrome » est refusé par de nombreux pare-feux applicatifs : on se présente comme un Chrome ordinaire.
    const ua = userAgent || (await cdp.send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
    await S('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.7' });
    if (headers && Object.keys(headers).length) await S('Network.setExtraHTTPHeaders', { headers });
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // alert() / confirm() bloqueraient la page indéfiniment.
    cdp.on((m) => { if (m.method === 'Page.javascriptDialogOpening' && m.sessionId === sessionId) S('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); });

    // Suivi du réseau : « au repos » = plus aucune requête en cours depuis un court instant.
    const inflight = new Map();
    let lastActivity = Date.now();
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Network.requestWillBeSent') {
        if (m.params.type !== 'WebSocket' && m.params.type !== 'EventSource') inflight.set(m.params.requestId, Date.now());
        lastActivity = Date.now();
      } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
        inflight.delete(m.params.requestId);
        lastActivity = Date.now();
      }
    });
    const networkIdle = async (quietMs, maxMs) => {
      const t0 = Date.now();
      for (;;) {
        const now = Date.now();
        for (const [id, t] of inflight) if (now - t > 6000) inflight.delete(id); // requêtes « long polling » : on n'attend pas
        if (!inflight.size && now - lastActivity >= quietMs) return;
        if (now - t0 > maxMs) return;
        await sleep(100);
      }
    };

    loaded = cdp.once('Page.loadEventFired', sessionId, timeoutMs);
    const nav = await S('Page.navigate', { url });
    if (nav.errorText) throw new Error(friendly(nav.errorText));
    await loaded.catch(() => { /* page très lente : on capture ce qui est déjà affiché */ });
    await networkIdle(700, 8000);

    // Bandeaux de consentement aux cookies : ils recouvrent le bas de la page et n'ont aucun intérêt dans un aperçu de
    // surveillance. Une feuille de style les masque dès qu'ils sont créés par le site (elle reste active pendant la capture).
    if (hideBanners) {
      await S('Runtime.evaluate', {
        expression: `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(`${COOKIE_BANNERS} { display: none !important; }`)}; document.documentElement.appendChild(s); })()`,
      }).catch(() => {});
    }

    // Beaucoup de sites WordPress (WP Rocket « retarder le JavaScript », NitroPack, Perfmatters…) n'exécutent leurs scripts
    // qu'à la PREMIÈRE INTERACTION d'un visiteur (souris, clavier, molette, toucher). Sans elle, jQuery, le slider, les menus
    // ne démarrent jamais : la capture montre une page à moitié vide. On simule donc un vrai visiteur avec des évènements
    // de confiance (le script les distingue des évènements synthétiques), puis on attend le chargement des scripts.
    if (interact) {
      const cx = Math.round(width / 2);
      const cy = Math.round(height / 2);
      for (const [dx, dy] of [[-160, -80], [0, 0], [110, 50]]) {
        await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + dx, y: cy + dy }).catch(() => {});
        await sleep(60);
      }
      await S('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 40 }).catch(() => {});
      await networkIdle(1000, 12000); // téléchargement et exécution des scripts retardés
    }

    // Le chargement différé des images (lazysizes, Layzr, Swiper…) et les animations « à l'apparition » ne se
    // déclenchent qu'au DÉFILEMENT : un visiteur qui descend la page les provoque, une capture doit en faire autant.
    // Attendre plus longtemps ne servirait à rien. Mode « écran visible » : deux écrans suffisent ; page entière : tout.
    const scrollLimit = fullPage ? 20000 : height * 2;
    await withTimeout(S('Runtime.evaluate', { expression: scrollThroughScript(scrollLimit), awaitPromise: true, returnByValue: true }), 25000);
    await networkIdle(700, 8000); // les images révélées par le défilement
    await sleep(settleMs); // animations d'entrée, fondus, sliders
    await networkIdle(500, 4000);

    let clip;
    if (fullPage) {
      const m = await S('Page.getLayoutMetrics');
      const full = Math.ceil(m.cssContentSize?.height || m.contentSize?.height || height);
      clip = { x: 0, y: 0, width, height: Math.min(Math.max(full, height), 5000), scale: 1 };
    }
    // Ce que Chrome affiche vraiment : adresse finale (après redirections) et titre de la page.
    const where = await S('Runtime.evaluate', { expression: '({ u: location.href, t: document.title })', returnByValue: true }).then((r) => r.result?.value, () => null);
    const shot = await S('Page.captureScreenshot', { format: 'jpeg', quality, ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    // Miniature : le haut de la page, réduite (≈ 10 Ko) pour que le tableau de bord reste léger.
    const small = await S('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width, height, scale: 360 / width } });
    return {
      image: Buffer.from(shot.data, 'base64'),
      thumb: Buffer.from(small.data, 'base64'),
      finalUrl: String(where?.u || '').slice(0, 500) || null,
      title: String(where?.t || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
      width,
      height: clip ? clip.height : height,
    };
  } finally {
    clearTimeout(hardStop);
    loaded?.cancel();
    try { ws?.close(); } catch { /* ignoré */ }
    kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  }
}

/** Point d'entrée remplaçable (tests, ou autre moteur de rendu). */
export const engine = { available: () => !!chromePath(), capture };

// ───────────── File d'attente : Chrome est gourmand, 2 captures en parallèle au maximum ─────────────

const MAX_PARALLEL = Math.max(1, Number(process.env.SCREENSHOT_CONCURRENCY) || 2);
let active = 0;
const waiting = [];

function queued(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        active--;
        waiting.shift()?.();
      }
    };
    if (active < MAX_PARALLEL) run();
    else waiting.push(run);
  });
}

// ───────────── Capture d'un site surveillé ─────────────

const inFlight = new Map();
export const isCapturing = (id) => inFlight.has(id);

/** Capture un site et l'enregistre. Ne lève jamais : retourne { id, ts, image } ou { error }. Une seule capture à la fois par site. */
export function captureWatch(id, { kind = 'scheduled' } = {}) {
  if (inFlight.has(id)) return inFlight.get(id);
  const p = doCapture(id, kind).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

async function doCapture(id, kind) {
  const w = await getWatch(id);
  if (!w) return { error: 'Site introuvable' };
  // Mode démo (voir scheduler.js) : on ne touche ni au réseau ni aux données de démonstration.
  if (process.env.VIGIE_DEMO === '1') return { error: 'Mode démo : les captures sont désactivées (données fictives).' };
  const sc = w.config.screenshot;
  const now = Date.now();
  try {
    if (!engine.available()) throw new Error(NO_CHROME);
    const r = await queued(() => engine.capture(w.url, {
      width: sc.width, height: sc.height, fullPage: sc.fullPage,
      settleMs: sc.delay * 1000, interact: sc.interact, hideBanners: sc.hideBanners,
      timeoutMs: Math.max(20, w.config.timeoutS) * 1000, headers: w.config.headers, userAgent: w.config.userAgent || undefined,
    }));
    const dir = join(SHOTS_DIR, String(id));
    await mkdir(dir, { recursive: true });
    const file = `${id}/${now}.jpg`;
    const thumb = r.thumb ? `${id}/${now}.t.jpg` : null;
    await writeFile(join(SHOTS_DIR, file), r.image);
    if (thumb) await writeFile(join(SHOTS_DIR, thumb), r.thumb);
    const shotId = await insertScreenshot({ watchId: id, ts: now, kind, file, thumb, size: r.image.length, width: r.width, height: r.height, finalUrl: r.finalUrl, title: r.title });
    await setShotState(id, { nextShot: now + sc.interval * 60e3, error: null });
    await pruneWatchShots(id);
    bus.emit('event', { type: 'shot', watchId: id });
    return { id: shotId, ts: now, image: r.image };
  } catch (e) {
    const error = e.message || String(e);
    console.error(`[capture] ${w.name} : ${error}`);
    // Nouvelle tentative plus tôt qu'à l'intervalle normal, sans marteler un site en panne.
    await setShotState(id, { nextShot: now + Math.min(sc.interval, 30) * 60e3, error });
    return { error };
  }
}

/**
 * Limites de conservation d'un site : `keep` captures planifiées (réglage du site, sinon réglage général), et le même nombre,
 * plafonné à 100, de captures manuelles ou d'alerte, qui ont leur quota et ne sont jamais écrasées par les planifiées.
 */
export function shotLimits(watch) {
  const keep = watch?.config?.screenshot?.keep || getSettings().retention.screenshots;
  return { keep, keepOther: Math.max(1, Math.min(100, keep)) };
}

/** Supprime les captures (lignes et fichiers) au-delà des limites du site. Retourne le nombre de captures supprimées. */
export async function pruneWatchShots(id) {
  const { keep, keepOther } = shotLimits(await getWatch(id));
  const rows = await screenshotsToPrune(id, keep, keepOther);
  if (!rows.length) return 0;
  await deleteScreenshotRows(rows.map((r) => r.id));
  for (const r of rows) for (const f of [r.file, r.thumb]) if (f) await unlink(join(SHOTS_DIR, f)).catch(() => {});
  return rows.length;
}

/** Applique les limites à tous les sites (après un changement du réglage général). */
export async function pruneAllShots() {
  let n = 0;
  for (const w of await listWatches()) n += await pruneWatchShots(w.id);
  return n;
}

/** Supprime les fichiers d'un site retiré. */
export const removeWatchShots = (id) => rm(join(SHOTS_DIR, String(id)), { recursive: true, force: true }).catch(() => {});

/** Nombre de fichiers présents (diagnostic / tests). */
export const shotFiles = (id) => readdir(join(SHOTS_DIR, String(id))).catch(() => []);
