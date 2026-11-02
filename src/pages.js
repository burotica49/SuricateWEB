// Pages supplémentaires d'un site (panier, contact, connexion…) : adresse résolue et nom affiché.
import { registrable } from './util.js';

/**
 * Adresse complète d'une page, ou null si elle n'appartient pas au site : http(s) uniquement, et même domaine
 * que le site surveillé (sous-domaines compris, ex. boutique.exemple.fr pour www.exemple.fr).
 */
export function resolvePage(siteUrl, page) {
  try {
    const base = new URL(siteUrl);
    const u = new URL(String(page?.url ?? ''), base);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (registrable(u.hostname) !== registrable(base.hostname)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Nom affiché : le libellé saisi, sinon le chemin (« /panier »). */
export function pageName(href, page) {
  if (page?.label) return page.label;
  try {
    const u = new URL(href);
    const path = decodeURIComponent(u.pathname) + u.search;
    return path.length > 60 ? `${path.slice(0, 57)}…` : path;
  } catch {
    return href;
  }
}
