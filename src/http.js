// Briques HTTP communes à l'application et à ses extensions : erreurs, réponses JSON / HTML, lecture du corps.
// Les extensions (version hébergée) importent d'ici : `throw new HttpError(402, '…')` se traduit en réponse HTTP.

/** Erreur dont le message est destiné à l'utilisateur : l'API la renvoie telle quelle avec ce statut. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Valeur que renvoie un gestionnaire qui a déjà écrit lui-même la réponse (image, flux, HTML…). */
export const HANDLED = Symbol.for('handled');

export const send = (res, status, data, headers = {}) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
};

/** Corps JSON de la requête, limité à 2 Mo. */
export async function readJson(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 2e6) throw new HttpError(413, 'Requête trop volumineuse');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

/** Pages publiques et rapports : aucun script en ligne, aucune ressource extérieure. */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function sendHtml(res, html, extra = {}) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': REPORT_CSP, ...extra,
  });
  res.end(buf);
  return HANDLED;
}

/**
 * Adresse IP du client. Derrière un reverse proxy (Traefik, nginx…), `trustProxy` active la lecture de X-Forwarded-For :
 * sans proxy de confiance, cet en-tête serait falsifiable et contournerait la limitation de tentatives.
 */
export const clientIpOf = (req, trustProxy) =>
  (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
