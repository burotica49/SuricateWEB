// Flux temps réel (SSE) : l'interface se met à jour sans recharger.
//
// Chaque utilisateur ne reçoit que les événements de SON compte. Un événement porte soit `accountId`, soit `watchId` (on retrouve
// alors le compte du site). Un événement dont on ne sait pas à quel compte il appartient n'est transmis à personne : mieux vaut
// manquer une mise à jour que montrer l'activité d'un autre compte.
import { bus } from '../events.js';
import { watchAccountId } from '../db.js';

export default function register({ route }) {
  route('GET', '/api/events', (ctx) => {
    const { req, res } = ctx;
    const mine = ctx.account.id;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');

    // Le compte d'un site ne change jamais : on le retient pour ne pas interroger la base à chaque événement.
    const siteAccount = new Map();
    const accountOf = async (e) => {
      if (e.accountId != null) return e.accountId;
      if (e.watchId == null) return null;
      if (!siteAccount.has(e.watchId)) siteAccount.set(e.watchId, await watchAccountId(e.watchId));
      return siteAccount.get(e.watchId);
    };
    // File d'attente : la recherche du compte est asynchrone, et les événements doivent arriver dans l'ordre où ils sont survenus.
    let queue = Promise.resolve();
    let closed = false;
    const on = (e) => {
      queue = queue
        .then(async () => {
          if (!closed && (await accountOf(e)) === mine) res.write(`data: ${JSON.stringify(e)}\n\n`);
        })
        .catch(() => {});
    };
    bus.on('event', on);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      closed = true;
      bus.off('event', on);
      clearInterval(ping);
    });
    return Symbol.for('handled');
  }, { perm: 'site:read' });
}
