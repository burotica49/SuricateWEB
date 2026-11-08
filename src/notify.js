// Canaux de notification : qui reçoit les alertes d'un site, et comment.
//
// Un canal est un objet :
//   { type, minSeverity, sendRecovery, wantsPhoto,
//     send(watch, alerts, settings)  → promesse (rejetée si l'envoi échoue),
//     sendPhoto?(image, caption)     → promesse (capture d'écran jointe aux alertes visuelles) }
//
// Le cœur ne connaît que Telegram, configuré dans les réglages. La version hébergée remplace `resolveChannels`
// (voir src/extensions.js) pour en fournir d'autres : e-mail, webhook, plusieurs canaux par groupe ou par site.
import { sendAlert, sendPhoto } from './telegram.js';
import { SEV } from './util.js';

/** Canal Telegram des réglages. La gravité minimale du site, si elle est définie, l'emporte sur celle des réglages. */
export function telegramChannel(t, watch) {
  return {
    type: 'telegram',
    minSeverity: watch.config.minSeverity || t.minSeverity,
    sendRecovery: t.sendRecovery,
    wantsPhoto: t.sendScreenshot,
    send: (w, alerts, settings) => sendAlert(t.token, t.chatId, w, alerts, settings),
    sendPhoto: (image, caption) => sendPhoto(t.token, t.chatId, image, caption),
  };
}

export const defaultNotifier = {
  /** Canaux à prévenir pour ces alertes : [] = personne. Peut renvoyer une promesse. */
  resolveChannels(watch, alerts, settings) {
    const t = settings.telegram;
    if (!t.enabled || !t.token || !t.chatId) return [];
    return [telegramChannel(t, watch)];
  },
};

/** Alertes qu'un canal doit recevoir : gravité minimale, et rétablissement seulement si l'incident qu'il clôt avait été signalé. */
export function eligibleFor(channel, alerts) {
  const min = SEV[channel.minSeverity] || 1;
  return alerts.filter((a) => (a.severity === 'recovery' ? channel.sendRecovery && (SEV[a.was] || 0) >= min : SEV[a.severity] >= min));
}
