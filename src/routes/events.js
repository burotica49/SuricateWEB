// Flux temps réel (SSE) : l'interface se met à jour sans recharger.
import { bus } from '../events.js';

export default function register({ route }) {
  route('GET', '/api/events', (ctx) => {
    const { req, res } = ctx;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const on = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    bus.on('event', on);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      bus.off('event', on);
      clearInterval(ping);
    });
    return Symbol.for('handled');
  }, { perm: 'site:read' });
}
