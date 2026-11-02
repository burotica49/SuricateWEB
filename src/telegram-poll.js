// Réception des clics sur les boutons Telegram, par interrogation régulière (getUpdates).
//
// VigieWeb demande à Telegram « y a-t-il eu des clics ? » : aucune adresse publique ni route ouverte sans connexion.
// Telegram n'admet qu'un lecteur à la fois : si le bot a un webhook, ou si le bouton « Détecter » interroge en même
// temps, la demande la plus récente l'emporte et l'autre reprend un instant plus tard.
import * as tg from './telegram.js';

/** « lu:<site>:<dernière alerte> » → { watchId, upTo }, ou null si ce n'est pas un de nos boutons. */
export function parseCallback(data) {
  const m = /^lu:(\d{1,9}):(\d{1,12})$/.exec(String(data ?? ''));
  return m ? { watchId: Number(m[1]), upTo: Number(m[2]) } : null;
}

/** Clavier après lecture : « Marquer comme lu » devient « ✓ Lu » (sans effet), les autres boutons restent. */
export function readKeyboard(rows) {
  return (rows || []).map((row) => row.map((b) => (parseCallback(b.callback_data) ? { text: '✓ Lu', callback_data: 'ok' } : b)));
}

/**
 * Lance la boucle. `settings()` renvoie les réglages Telegram à chaque tour (un changement dans l'interface est pris en compte
 * sans redémarrage) ; `onRead(watchId, upTo)` marque les alertes comme lues et retourne leur nombre.
 * @returns {{ stop(): void }}
 */
export function startTelegramPoller({ settings, onRead, pollSeconds = 25, idleMs = 5000, log = console } = {}) {
  let stopped = false;
  let offset = 0;
  let lastToken = '';
  let failures = 0;
  let abort = null;
  let wake = null;
  const warned = new Set();
  const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); log.warn(msg); } };
  const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });

  async function handle(cq, t) {
    const reply = (text, alert = false) => tg.answerCallbackQuery(t.token, cq.id, text, alert).catch(() => {});
    // Seule la conversation configurée a le droit d'agir : un clic venu d'ailleurs est refusé.
    const chatId = String(cq.message?.chat?.id ?? '');
    if (!chatId || chatId !== String(t.chatId)) return reply('Action non autorisée.', true);
    if (cq.data === 'ok') return reply('Déjà marqué comme lu.');
    const cb = parseCallback(cq.data);
    if (!cb) return reply('Ce bouton n’est plus valable.');

    let n;
    try {
      n = await onRead(cb.watchId, cb.upTo);
    } catch (e) {
      log.error(`[telegram] marquage comme lu : ${e.message}`);
      return reply('Échec : réessayez depuis VigieWeb.', true);
    }
    await reply(n > 1 ? `${n} alertes marquées comme lues.` : n === 1 ? 'Alerte marquée comme lue.' : 'Déjà marqué comme lu.');
    const rows = cq.message?.reply_markup?.inline_keyboard;
    if (rows) await tg.editMessageReplyMarkup(t.token, chatId, cq.message.message_id, { inline_keyboard: readKeyboard(rows) }).catch(() => {});
  }

  async function loop() {
    while (!stopped) {
      const t = settings();
      if (!(t.token && t.chatId && t.enabled && t.buttons !== false)) {
        await sleep(idleMs);
        continue;
      }
      if (t.token !== lastToken) { lastToken = t.token; offset = 0; failures = 0; }
      try {
        abort = new AbortController();
        const updates = await tg.getUpdates(t.token, { offset, timeout: pollSeconds, allowed_updates: ['callback_query'] }, abort.signal);
        failures = 0;
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1); // même en cas d'échec : on ne rejoue pas un clic
          if (u.callback_query) await handle(u.callback_query, t).catch((e) => log.error(`[telegram] clic : ${e.message}`));
        }
      } catch (e) {
        if (stopped || e.aborted) break;
        if (e.status === 409 && /webhook/i.test(e.description || '')) {
          warnOnce('webhook', '[telegram] ce bot a un webhook : les boutons « Marquer comme lu » ne peuvent pas être reçus (supprimez le webhook, ou désactivez les boutons).');
          await sleep(10 * 60e3);
        } else if (e.status === 409) {
          await sleep(1000); // un autre lecteur vient de passer devant (« Détecter ») : on reprend juste après
        } else if (e.status === 401 || e.status === 404) {
          warnOnce('token', '[telegram] jeton refusé : les boutons sont inactifs tant qu’il n’est pas corrigé (Réglages › Telegram).');
          await sleep(5 * 60e3);
        } else {
          failures++;
          await sleep(Math.min(60e3, 5000 * 2 ** Math.min(failures - 1, 4)));
        }
      }
    }
  }
  loop();
  return { stop() { stopped = true; abort?.abort(); wake?.(); } };
}
