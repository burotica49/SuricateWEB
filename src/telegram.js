import { esc, SEV } from './util.js';

const API = process.env.TELEGRAM_API || 'https://api.telegram.org';

async function call(token, method, body) {
  if (!token) throw new Error('Jeton du bot Telegram manquant');
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Telegram injoignable (${e.cause?.code || e.name})`);
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    const d = j.description || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 404) throw new Error('Jeton invalide : vérifiez le jeton donné par @BotFather');
    if (/chat not found/i.test(d)) throw new Error("Conversation introuvable : écrivez d'abord /start à votre bot, puis utilisez « Détecter »");
    throw new Error(d);
  }
  return j.result;
}

export const getMe = (token) => call(token, 'getMe');

export function sendMessage(token, chatId, html) {
  if (!chatId) throw new Error('Identifiant de conversation (chat ID) manquant');
  return call(token, 'sendMessage', {
    chat_id: chatId,
    text: html.length > 4000 ? html.slice(0, 3990) + '…' : html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

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
  const updates = await call(token, 'getUpdates', { limit: 100, timeout: 0 });
  const seen = new Map();
  for (const u of updates) {
    const chat = (u.message || u.channel_post || u.my_chat_member || u.edited_message)?.chat;
    if (chat) seen.set(String(chat.id), { id: String(chat.id), type: chat.type, title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id) });
  }
  return [...seen.values()];
}

const ICON = { critical: '🚨', warning: '⚠️', info: 'ℹ️', recovery: '✅' };
const LABEL = { critical: 'CRITIQUE', warning: 'ATTENTION', info: 'INFO', recovery: 'RÉTABLI' };

/** Un seul message par contrôle, même s'il contient plusieurs alertes. */
export function buildMessage(watch, alerts, settings) {
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
  if (/^https?:\/\//.test(base)) msg += `\n<a href="${esc(base)}/#/sites/${watch.id}">Ouvrir dans VigieWeb</a>`;
  return msg;
}
