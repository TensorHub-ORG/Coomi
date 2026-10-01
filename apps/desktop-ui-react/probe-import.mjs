
globalThis.window = globalThis;
globalThis.localStorage = (() => { const m = new Map(); return {
  getItem: (k) => m.has(k) ? m.get(k) : null,
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
  clear: () => m.clear(),
  key: (i) => [...m.keys()][i] ?? null,
  get length() { return m.size; }
}; })();
globalThis.document = {
  hidden: false, hasFocus: () => true, addEventListener: () => {}, removeEventListener: () => {},
  documentElement: { dataset: {}, style: { setProperty: () => {} }, addEventListener: () => {} },
  createElement: () => ({ style: {} }),
  getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  dispatchEvent: () => true,
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((cb) => setTimeout(() => cb(Date.now()), 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.WebSocket = globalThis.WebSocket || class { static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; constructor() {} send() {} close() {} };

import { useSession } from './src/stores/session.ts'
console.log('IMPORT_OK', typeof useSession.getState, 'sessions:', useSession.getState().sessions.length)
