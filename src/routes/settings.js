// Réglages et Telegram (test d'envoi, détection de la conversation).
//
// Deux niveaux (voir db.js) : les réglages du COMPTE (Telegram, mots-clés, User-Agent, intervalle par défaut, seuil CMS,
// conservation des captures) sont lus et écrits pour le compte de l'utilisateur. Ceux de l'INSTALLATION (adresse publique de
// SuricateWeb) ne se modifient qu'avec le droit « instance:write » : accordé par défaut dans le cœur, refusé aux comptes clients
// de la version hébergée, qui ne doivent pas changer l'adresse de tout le monde.
import { HttpError } from '../http.js';
import { settingsFor, saveAccountSettings, saveInstanceSettings, MAX_KEEP } from '../db.js';
import { pruneAllShots } from '../screenshot.js';
import * as tg from '../telegram.js';
import { clamp } from '../util.js';
import { publicSettings } from './shared.js';

export default function register({ route }) {
  route('GET', '/api/settings', async (ctx) => publicSettings(ctx), { perm: 'settings:read' });

  route('PUT', '/api/settings', async (ctx) => {
    const b = ctx.body;
    const accountId = ctx.account.id;
    const cur = await settingsFor(accountId);
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
    if (b.defaultInterval !== undefined) patch.defaultInterval = clamp(b.defaultInterval, 1, 10080, 15);
    const keepAll = b.retention?.screenshots !== undefined ? Math.round(clamp(b.retention.screenshots, 1, MAX_KEEP, 168)) : null;
    if (keepAll !== null) patch.retention = { screenshots: keepAll };
    if (b.cmsAfterDays !== undefined) patch.cmsAfterDays = Math.round(clamp(b.cmsAfterDays, 1, 90, 7));
    if (b.userAgent !== undefined) patch.userAgent = String(b.userAgent).trim() || cur.userAgent;
    if (Array.isArray(b.builtinKeywords)) patch.builtinKeywords = b.builtinKeywords.map((s) => String(s).trim()).filter(Boolean).slice(0, 300);

    // Adresse publique : propre à l'installation (liens des boutons Telegram). Vérifier le droit AVANT d'écrire quoi que ce soit.
    if (b.baseUrl !== undefined) await ctx.require('instance:write');
    if (b.baseUrl !== undefined) await saveInstanceSettings({ baseUrl: String(b.baseUrl).trim().replace(/\/+$/, '') });
    await saveAccountSettings(accountId, patch);
    if (keepAll !== null && keepAll !== cur.retention.screenshots) await pruneAllShots(accountId); // limite abaissée : appliquée aux sites du compte
    return await publicSettings(ctx);
  }, { perm: 'settings:write' });

  /** Jeton du formulaire, sinon celui déjà enregistré pour le compte. */
  const tokenFrom = async (ctx) => String(ctx.body.token || '').trim() || (await settingsFor(ctx.account.id)).telegram.token;

  route('POST', '/api/telegram/test', async (ctx) => {
    const token = await tokenFrom(ctx);
    const chatId = String(ctx.body.chatId || '').trim() || (await settingsFor(ctx.account.id)).telegram.chatId;
    try {
      const me = await tg.getMe(token);
      await tg.sendMessage(token, chatId, `✅ <b>SuricateWeb est connecté</b>\nLes alertes de surveillance arriveront ici.\n<i>Bot : @${me.username}</i>`);
      return { ok: true, bot: me.username };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }, { perm: 'settings:write' });

  route('POST', '/api/telegram/detect', async (ctx) => {
    try {
      const token = await tokenFrom(ctx);
      const me = await tg.getMe(token);
      return { bot: me.username, chats: await tg.detectChats(token) };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }, { perm: 'settings:write' });
}
