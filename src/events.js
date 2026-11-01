import { EventEmitter } from 'node:events';

/** Bus interne : le scheduler/checker publie, le endpoint SSE relaie vers l'interface. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
