import { esc, SEV } from './util.js';

const API = process.env.TELEGRAM_API || 'https://api.telegram.org';

/** `timeoutMs` : 15 s par défaut ; l'interrogation longue (getUpdates) en demande davantage. `signal` permet de l'annuler. */
async function call(token, method, body, { timeoutMs = 15000, signal } = {}) {
  if (!token) throw new Error('Jeton du bot Telegram manquant');
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('Interrogation annulée'), { aborted: true });
    throw new Error(`Telegram injoignable (${e.cause?.code || e.name})`);
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    const d = j.description || `HTTP ${res.status}`;
    const fail = (msg) => Object.assign(new Error(msg), { status: res.status, description: d });
    if (res.status === 401 || res.status === 404) throw fail('Jeton invalide : vérifiez le jeton donné par @BotFather');
    if (/chat not found/i.test(d)) throw fail("Conversation introuvable : écrivez d'abord /start à votre bot, puis utilisez « Détecter »");
    throw fail(d);
  }
  return j.result;
}

export const getMe = (token) => call(token, 'getMe');

export function sendMessage(token, chatId, html, replyMarkup) {
  if (!chatId) throw new Error('Identifiant de conversation (chat ID) manquant');
  return call(token, 'sendMessage', {
    chat_id: chatId,
    text: html.length > 4000 ? html.slice(0, 3990) + '…' : html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/** Interrogation longue : Telegram répond dès qu'un clic arrive, ou au bout de `timeout` secondes. */
export const getUpdates = (token, params, signal) => call(token, 'getUpdates', params, { timeoutMs: (params.timeout || 0) * 1000 + 15000, signal });
export const answerCallbackQuery = (token, id, text = '', alert = false) => call(token, 'answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 200), show_alert: alert });
export const editMessageReplyMarkup = (token, chatId, messageId, replyMarkup) => call(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });

/** Envoie une image (JPEG) avec légende. Limite Telegram : 10 Mo, largement suffisante pour nos captures. */
export async function sendPhoto(token, chatId, image, caption = '') {
  if (!token) throw new Error('Jeton du bot Telegram manquant');
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (caption) form.set('caption', caption.slice(0, 1000));
  form.set('photo', new Blob([image], { type: 'image/jpeg' }), 'capture.jpg');
  let res;
  try {
    res = await fetch(`${API}/bot${token}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Telegram injoignable (${e.cause?.code || e.name})`);
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `HTTP ${res.status}`);
  return j.result;
}

/** Retrouve les conversations qui ont écrit au bot (pour obtenir le chat ID sans manipulation). */
export async function detectChats(token) {
  // Types demandés explicitement : Telegram retient ceux de la dernière interrogation, et le lecteur des boutons n'en demande qu'un.
  const updates = await call(token, 'getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member', 'edited_message', 'callback_query'] });
  const seen = new Map();
  for (const u of updates) {
    const chat = (u.message || u.channel_post || u.my_chat_member || u.edited_message || u.callback_query?.message)?.chat;
    if (chat) seen.set(String(chat.id), { id: String(chat.id), type: chat.type, title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id) });
  }
  return [...seen.values()];
}

const ICON = { critical: '🚨', warning: '⚠️', info: 'ℹ️', recovery: '✅' };
const LABEL = { critical: 'CRITIQUE', warning: 'ATTENTION', info: 'INFO', recovery: 'RÉTABLI' };

/** Un seul message par contrôle, même s'il contient plusieurs alertes. */
export function buildMessage(watch, alerts, settings, { link = true } = {}) {
  const top = alerts.reduce((a, b) => ((SEV[b.severity] || 0) > (SEV[a.severity] || 0) ? b : a), alerts[0]);
  const head = `${ICON[top.severity]} <b>${LABEL[top.severity]}</b> · ${esc(watch.name)}`;
  const body = alerts
    .map((a) => {
      let s = `${alerts.length > 1 ? ICON[a.severity] + ' ' : ''}<b>${esc(a.title)}</b>`;
      if (a.detail) s += `\n${esc(a.detail)}`;
      if (a.diffPreview && settings.telegram.includeDiff) s += `\n<pre>${esc(a.diffPreview)}</pre>`;
      return s;
    })
    .join('\n\n');
  let msg = `${head}\n\n${body}\n\n🔗 ${esc(watch.url)}`;
  const base = (settings.baseUrl || '').replace(/\/+$/, '');
  if (link && /^https?:\/\//.test(base)) msg += `\n<a href="${esc(base)}/#/sites/${watch.id}">Ouvrir dans SuricateWeb</a>`;
  return msg;
}

// ───────────── Boutons sous le message ─────────────

/** Adresses que Telegram refuse dans un bouton (ou qui ne servent à rien depuis un téléphone). */
const NON_PUBLIC = /^(localhost|.+\.(localhost|local|internal|lan|home)|0\.0\.0\.0|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|169\.254\.[\d.]+|\[.*\])$/i;

/** Adresse de la page du site dans SuricateWeb, si l'adresse publique de SuricateWeb est utilisable dans un bouton. */
export function siteLink(baseUrl, watchId) {
  let u;
  try {
    u = new URL(String(baseUrl || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || NON_PUBLIC.test(u.hostname)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/#/sites/${watchId}`;
}

/**
 * Une ligne de boutons : « Marquer comme lu » (reçu par SuricateWeb, voir telegram-poll.js) et « Ouvrir dans SuricateWeb ».
 * `callback_data` (64 octets au plus) : « lu:<site>:<dernière alerte du message> ».
 * @returns {{ row: object[], link: boolean }} `link` : le lien est porté par un bouton (inutile de le répéter dans le texte).
 */
export function buildKeyboard(watch, alerts, settings) {
  if (settings.telegram.buttons === false) return { row: [], link: false };
  const row = [];
  // Les messages « rétabli » sont déjà lus : rien à marquer.
  const ids = alerts.filter((a) => a.severity !== 'recovery' && a.id).map((a) => a.id);
  if (ids.length) row.push({ text: '✓ Marquer comme lu', callback_data: `lu:${watch.id}:${Math.max(...ids)}` });
  const url = siteLink(settings.baseUrl, watch.id);
  if (url) row.push({ text: 'Ouvrir dans SuricateWeb', url });
  return { row, link: !!url };
}

/**
 * Envoie l'alerte avec ses boutons. Si Telegram refuse un bouton (adresse jugée invalide…), on réessaie sans le bouton lien,
 * puis sans aucun bouton : une alerte ne doit jamais se perdre à cause d'un bouton.
 */
export async function sendAlert(token, chatId, watch, alerts, settings) {
  const kb = buildKeyboard(watch, alerts, settings);
  const attempt = (row, link) => sendMessage(token, chatId, buildMessage(watch, alerts, settings, { link }), row.length ? { inline_keyboard: [row] } : undefined);
  const tries = [[kb.row, !kb.link]];
  if (kb.row.length) {
    const withoutLink = kb.row.filter((b) => !b.url);
    if (withoutLink.length !== kb.row.length && withoutLink.length) tries.push([withoutLink, true]);
    tries.push([[], true]);
  }
  let last;
  for (const [row, link] of tries) {
    try {
      return await attempt(row, link);
    } catch (e) {
      last = e;
      if (!/button|url|markup|keyboard/i.test(e.message)) throw e;
    }
  }
  throw last;
}
