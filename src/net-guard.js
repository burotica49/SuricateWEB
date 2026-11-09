// Garde réseau : empêche SuricateWeb d'être utilisé pour atteindre le réseau INTERNE du serveur qui l'héberge (SSRF).
//
// Le problème. SuricateWeb va chercher des adresses saisies par ses utilisateurs : contrôles, relevé CMS, certificat TLS, captures
// d'écran. Sans garde, quelqu'un peut déclarer « http://169.254.169.254/ » (service de métadonnées d'un hébergeur cloud, qui livre
// des identifiants), « http://localhost:5432/ » ou un nom de domaine qui pointe vers 10.0.0.12, et lire ce que SuricateWeb y trouve
// (statut, titre, message d'erreur, capture d'écran). Dans une installation personnelle ce n'est pas un risque (l'utilisateur
// est le propriétaire, et surveiller un site interne est légitime) : la garde est donc DÉSACTIVÉE par défaut. Une installation
// ouverte à des inconnus (la version hébergée) l'active.
//
// Ce que la garde refuse, quand elle est active :
//   - tout ce qui n'est pas http:// ou https:// ;
//   - les ports hors liste (80, 443, 8080, 8443 par défaut) : pas de balayage de ports ;
//   - toute adresse IP privée ou réservée (boucle locale, 10/8, 172.16/12, 192.168/16, lien local 169.254/16, CGNAT, multicast,
//     IPv6 locales, adresses IPv4 « mappées » en IPv6…), qu'elle soit écrite dans l'adresse ou renvoyée par le DNS.
//
// Le point délicat : le contrôle doit porter sur l'adresse IP à laquelle on SE CONNECTE, pas sur celle que le DNS a donnée une
// seconde plus tôt. Un attaquant qui maîtrise son DNS répond une adresse publique au contrôle puis une adresse privée à la
// connexion (« DNS rebinding »). Ici, la résolution et la vérification se font dans le `lookup` de la connexion elle-même :
// l'adresse vérifiée est exactement celle utilisée. Les requêtes passent donc par un petit client HTTP maison (guardedFetch) au
// lieu de fetch(), dont on ne peut pas brancher le `lookup`.
//
// Limite connue : Chrome (captures d'écran) résout les adresses lui-même. Ses requêtes sont interceptées et vérifiées une à une,
// mais l'adresse vérifiée peut différer de celle de la connexion. Pour une garantie complète, faire tourner Chrome dans un
// conteneur ou un réseau sans accès à l'interne (voir le README).
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

/** Erreur de la garde : le message est destiné à l'utilisateur ; `code` vaut « ESSRF » (reconnu par describeError). */
export class NetGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetGuardError';
    this.code = 'ESSRF';
  }
}

// ───────────── Adresses privées ou réservées ─────────────

const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(address, prefix, 'ipv6');

/** Adresse IPv4 contenue dans une adresse IPv6 « mappée » (::ffff:a.b.c.d), quelle que soit son écriture ; sinon null. */
function mappedIPv4(address) {
  let host;
  try {
    host = new URL(`http://[${address}]/`).hostname; // forme canonique : ::ffff:7f00:1
  } catch {
    return null;
  }
  const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Vrai pour une adresse privée, réservée, ou qui n'est pas une adresse IP : dans le doute, on refuse. */
export function isBlockedAddress(address) {
  const a = String(address ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // crochets et zone IPv6 (fe80::1%eth0)
  if (net.isIPv4(a)) return BLOCKED.check(a, 'ipv4');
  if (net.isIPv6(a)) {
    const v4 = mappedIPv4(a);
    return v4 ? BLOCKED.check(v4, 'ipv4') : BLOCKED.check(a, 'ipv6');
  }
  return true;
}

// ───────────── La garde ─────────────

const DEFAULT_PORTS = [80, 443, 8080, 8443];

const disabled = Object.freeze({
  enabled: false,
  checkUrl() {},
  allows: async () => true,
  lookup: undefined,
  fetch: (...args) => globalThis.fetch(...args),
});

/** Liste « a, b, c » (variable d'environnement) → tableau sans blancs ni doublons. */
const list = (v) => [...new Set(String(v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];

/**
 * @param enabled        false → garde inerte (comportement d'origine)
 * @param allowedPorts   ports autorisés ; '*' = tous
 * @param allowHosts     exceptions explicites : noms d'hôtes (« intranet.exemple »), adresses (« 10.0.0.5 ») ou plages (« 10.1.0.0/16 »)
 *                       qu'on a le droit de surveiller malgré tout
 */
export function createNetGuard({ enabled = true, allowedPorts = DEFAULT_PORTS, allowHosts = [] } = {}) {
  if (!enabled) return disabled;
  const anyPort = allowedPorts === '*' || (Array.isArray(allowedPorts) && allowedPorts.includes('*'));
  const ports = new Set(anyPort ? [] : allowedPorts.map(Number));
  const exemptNames = new Set();
  const exemptNets = new net.BlockList();
  for (const e of Array.isArray(allowHosts) ? allowHosts : list(allowHosts)) {
    const entry = String(e).trim().toLowerCase();
    const cidr = /^(.+)\/(\d{1,3})$/.exec(entry);
    if (cidr && net.isIP(cidr[1])) exemptNets.addSubnet(cidr[1], Number(cidr[2]), net.isIPv4(cidr[1]) ? 'ipv4' : 'ipv6');
    else if (net.isIP(entry)) exemptNets.addAddress(entry, net.isIPv4(entry) ? 'ipv4' : 'ipv6');
    else if (entry) exemptNames.add(entry);
  }
  const exemptAddress = (ip) => {
    const a = String(ip).replace(/^\[|\]$/g, '');
    const v4 = net.isIPv6(a) ? mappedIPv4(a) : null;
    const target = v4 ?? a;
    return exemptNets.check(target, net.isIPv4(target) ? 'ipv4' : 'ipv6');
  };
  const blockedAddress = (ip) => isBlockedAddress(ip) && !exemptAddress(ip);

  /** Vérification SANS réseau : schéma, port, adresse IP écrite telle quelle, « localhost ». Lève une NetGuardError. */
  function checkUrl(input) {
    let url;
    try {
      url = input instanceof URL ? input : new URL(String(input));
    } catch {
      throw new NetGuardError('Adresse invalide');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetGuardError('Seules les adresses http:// et https:// sont autorisées');
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    if (!anyPort && !ports.has(port)) throw new NetGuardError(`Port ${port} non autorisé (ports acceptés : ${[...ports].join(', ')})`);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (exemptNames.has(host)) return;
    if (net.isIP(host)) {
      if (blockedAddress(host)) throw new NetGuardError('Adresse non autorisée : réseau privé ou interne');
    } else if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new NetGuardError('Adresse non autorisée : réseau privé ou interne');
    }
  }

  /**
   * `lookup` d'une connexion (net.connect, tls.connect, http.request) : résout le nom ET vérifie les adresses obtenues avant de
   * les rendre à la connexion. Aucune fenêtre entre le contrôle et la connexion : c'est ce qui bloque le DNS rebinding.
   * Si UNE des adresses est interdite, tout est refusé (un nom qui mêle publique et privée est un piège).
   */
  function lookup(hostname, options, callback) {
    if (typeof options === 'function') [callback, options] = [options, {}];
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (!exemptNames.has(String(hostname).toLowerCase())) {
        const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
        const bad = addresses.find(blockedAddress);
        if (bad) return callback(new NetGuardError('Adresse non autorisée : ce nom de domaine pointe vers un réseau privé ou interne'));
      }
      callback(null, address, family);
    });
  }

  /** Comme checkUrl, mais résout aussi le nom : pour les requêtes de Chrome, qu'on ne peut pas faire passer par `lookup`. */
  async function allows(input) {
    let url;
    try {
      checkUrl(input);
      url = input instanceof URL ? input : new URL(String(input));
    } catch {
      return false;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(host) || exemptNames.has(host)) return true; // déjà jugée par checkUrl
    try {
      const found = await dns.promises.lookup(host, { all: true });
      return found.length > 0 && !found.some((a) => blockedAddress(a.address));
    } catch {
      return true; // nom introuvable : Chrome échouera de lui-même (et il n'atteint rien)
    }
  }

  /**
   * fetch() en lecture seule (GET, redirections laissées à l'appelant) avec contrôle de l'adresse à la connexion.
   * Renvoie une vraie Response : le reste du code ne voit aucune différence avec fetch().
   * Réponses gzip, deflate et brotli décompressées, comme le fait fetch.
   */
  function guardedFetch(input, init = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(String(input));
        checkUrl(url);
      } catch (e) {
        return reject(e);
      }
      const lib = url.protocol === 'https:' ? https : http;
      const headers = { 'accept-encoding': 'gzip, deflate, br', connection: 'close' };
      for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
      const signal = init.signal;
      if (signal?.aborted) return reject(signal.reason);
      let body = null; // le corps de la réponse, une fois qu'on l'a
      // Le délai est ici le même que celui de fetch() : la raison du signal (TimeoutError, AbortError) est celle que reçoit l'appelant,
      // avant la réponse comme pendant la lecture du corps.
      const onAbort = () => {
        const reason = signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
        req.destroy(reason);
        body?.destroy(reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const req = lib.request(url, { method: init.method || 'GET', headers, lookup, agent: false }, (res) => {
        const status = res.statusCode;
        const out = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
        const decoder = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding];
        // Pas de corps : redirections (le corps ne sert à rien et peut être énorme), 204, 205, 304.
        if ((status >= 300 && status < 400) || status === 204 || status === 205 || status === 304) {
          res.resume();
          signal?.removeEventListener('abort', onAbort);
          return resolve(new Response(null, { status, statusText: res.statusMessage, headers: out }));
        }
        let stream = res;
        if (decoder) {
          stream = decoder();
          res.on('error', (e) => stream.destroy(e));
          res.pipe(stream);
          out.delete('content-encoding');
          out.delete('content-length'); // la taille annoncée est celle du corps compressé
        }
        body = stream;
        // Le lecteur renonce (page trop volumineuse, délai) : on coupe la connexion.
        stream.on('close', () => {
          signal?.removeEventListener('abort', onAbort);
          req.destroy();
        });
        resolve(new Response(Readable.toWeb(stream), { status, statusText: res.statusMessage, headers: out }));
      });
      req.on('error', (e) => {
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
      req.end();
    });
  }

  return { enabled: true, allowedPorts: anyPort ? '*' : [...ports], checkUrl, allows, lookup, fetch: guardedFetch };
}

/**
 * La garde décrite par l'environnement, ou null si elle n'y est pas demandée :
 *   SURICATE_NET_GUARD=1                       active la garde
 *   SURICATE_NET_ALLOW_PORTS=80,443,8080,8443  ports autorisés (« * » = tous)
 *   SURICATE_NET_ALLOW_HOSTS=intranet.exemple,10.0.0.5,10.1.0.0/16   exceptions explicites
 */
export function netGuardFromEnv(env = process.env) {
  if (!/^(1|true|yes)$/i.test(env.SURICATE_NET_GUARD || '')) return null;
  const ports = list(env.SURICATE_NET_ALLOW_PORTS);
  return createNetGuard({ allowedPorts: ports.length ? ports : DEFAULT_PORTS, allowHosts: list(env.SURICATE_NET_ALLOW_HOSTS) });
}
