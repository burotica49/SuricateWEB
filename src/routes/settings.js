// Réglages de l'installation et Telegram (test d'envoi, détection de la conversation).
import { HttpError } from '../http.js';
import { getSettings, saveSettings, MAX_KEEP } from '../db.js';
import { pruneAllShots } from '../screenshot.js';
import * as tg from '../telegram.js';
import { clamp } from '../util.js';
import { publicSettings } from './shared.js';

export default function register({ route }) {
  route('GET', '/api/settings', async (ctx) => publicSettings(ctx), { perm: 'settings:read' });

  route('PUT', '/api/settings', async (ctx) => {
    const b = ctx.body;
    const cur = getSettings();
    const patch = {};
    if (b.telegram) {
      const t = b.telegram;
      patch.telegram = {
        token: t.token ? String(t.token).trim() : cur.telegram.token,
        chatId: t.chatId !== undefined ? String(t.chatId).trim() : cur.telegram.chatId,
        enabled: t.enabled !== undefined ? !!t.enabled : cur.telegram.enabled,
        minSeverity: ['info', 'warning', 'critical'].includes(t.minSeverity) ? t.minSeverity : cur.telegram.minSeverity,
        sendRecovery: t.sendRecovery !== undefined ? !!t.sendRecovery : cur.telegram.sendRecovery,
        includeDiff: t.includeDiff !== undefined ? !!t.includeDiff : cur.telegram.includeDiff,
        sendScreenshot: t.sendScreenshot !== undefined ? !!t.sendScreenshot : cur.telegram.sendScreenshot,
        buttons: t.buttons !== undefined ? !!t.buttons : cur.telegram.buttons,
      };
      if (t.clearToken) patch.telegram.token = '';
    }
    if (b.baseUrl !== undefined) patch.baseUrl = String(b.baseUrl).trim().replace(/\/+$/, '');
    if (b.defaultInterval !== undefined) patch.defaultInterval = clamp(b.defaultInterval, 1, 10080, 15);
    const keepAll = b.retention?.screenshots !== undefined ? Math.round(clamp(b.retention.screenshots, 1, MAX_KEEP, 168)) : null;
    if (keepAll !== null) patch.retention = { screenshots: keepAll };
    if (b.cmsAfterDays !== undefined) patch.cmsAfterDays = Math.round(clamp(b.cmsAfterDays, 1, 90, 7));
    if (b.userAgent !== undefined) patch.userAgent = String(b.userAgent).trim() || cur.userAgent;
    if (Array.isArray(b.builtinKeywords)) patch.builtinKeywords = b.builtinKeywords.map((s) => String(s).trim()).filter(Boolean).slice(0, 300);
    await saveSettings(patch);
    if (keepAll !== null && keepAll !== cur.retention.screenshots) await pruneAllShots(); // limite abaissée : appliquée à tous les sites
    return await publicSettings(ctx);
  }, { perm: 'settings:write' });

  const tokenFrom = (body) => String(body.token || '').trim() || getSettings().telegram.token;

  route('POST', '/api/telegram/test', async (ctx) => {
    const token = tokenFrom(ctx.body);
    const chatId = String(ctx.body.chatId || '').trim() || getSettings().telegram.chatId;
    try {
      const me = await tg.getMe(token);
      await tg.sendMessage(token, chatId, `✅ <b>VigieWeb est connecté</b>\nLes alertes de surveillance arriveront ici.\n<i>Bot : @${me.username}</i>`);
      return { ok: true, bot: me.username };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }, { perm: 'settings:write' });

  route('POST', '/api/telegram/detect', async (ctx) => {
    try {
      const token = tokenFrom(ctx.body);
      const me = await tg.getMe(token);
      return { bot: me.username, chats: await tg.detectChats(token) };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }, { perm: 'settings:write' });

}
