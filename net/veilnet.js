// Veil's network layers. Loaded only by the networked edition of SWARM OS (never inside the
// claude.ai artifact, which blocks all connections). The Veil app talks to window.VeilNet.
//
// Three routes, none of which ever falls back to a direct connection:
//   chain  You → Nym mixnet (entry gateway, 3 mix layers, exit) → Wisp relay → Tor guard → middle → exit → site
//   tor    You → tor-js gateway (a bridge) → Tor guard → middle → exit → site
//   nym    You → Nym mixnet → Nym exit → site
//
// Libraries (vendored next to this file, versions pinned by the build):
//   tor-js        Arti, the Tor Project's Rust client, compiled to WebAssembly (Ethereum Foundation PSE)
//   mix-tunnel    Nym's smolmix WASM client (userspace TCP/IP + rustls) in a worker
//   mix-websocket WebSockets carried through the same mixnet tunnel
import { WispClient, streamParts } from './wisp.js';

const CFG = Object.assign({
  torGateway: '152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ', // public tor-js demo gateway
  wispUrl: 'wss://wisp.mercurywork.shop/',                                          // public Wisp relay
  bootstrapUrl: 'https://tor-js-gateway.pse.dev/bootstrap.zip.zst',                  // Tor directory snapshot (signed data; Arti verifies it)
  checkUrl: 'https://check.torproject.org/api/ip',
}, globalThis.__VEIL_CONFIG__ || {});

const layers = {
  nym:   { name: 'Nym mixnet',  state: 'idle', detail: '' },
  relay: { name: 'Wisp relay',  state: 'idle', detail: '' },
  tor:   { name: 'Tor (in the mixnet)', state: 'idle', detail: '' },
  torgw: { name: 'Tor (via gateway)',   state: 'idle', detail: '' },
};
const listeners = new Set();
const logs = [];
const secs = t0 => ((performance.now() - t0) / 1000).toFixed(1) + ' s';
const errText = e => (e && (e.message || e.reason || String(e))) || 'unknown error';
function set(id, state, detail) {
  const l = layers[id];
  if (state) l.state = state;
  if (detail != null) l.detail = String(detail).slice(0, 200);
  logs.push({ t: Date.now(), layer: id, state: l.state, msg: l.detail });
  if (logs.length > 500) logs.shift();
  for (const f of listeners) { try { f(id, Object.assign({}, l)); } catch (_) {} }
}
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(new Error(what + ' (timed out after ' + Math.round(ms / 1000) + ' s)')), ms); })]).finally(() => clearTimeout(t));
}
function parseTarget(t) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(t) || /^([^:]+):(\d+)$/.exec(t);
  if (!m) throw new Error('bad relay address ' + t);
  return { host: m[1], port: +m[2] };
}

// ── libraries (loaded on first use) ──
let torMod = null;
async function torLib() {
  if (!torMod) {
    const T = await import('./vendor/tor-js/index.js');
    T.setWasmUrl(new URL('./vendor/tor-js/tor_js_bg.wasm', import.meta.url).href);
    torMod = T;
  }
  return torMod;
}
function torStorage(T, name) {
  // IndexedDB keeps the (public, signed) directory between visits so later bootstraps are faster. It needs the
  // cross-tab lock wrapper; tor-js's README shows the bare class, which fails with "Storage must implement tryLock()".
  try { if (typeof indexedDB !== 'undefined') return T.storage.addLocking(new T.storage.IndexedDBStorage(name), name); } catch (_) {}
  return new T.storage.MemoryStorage();
}
function torLog(T, id) {
  return new T.Log({
    rawLog: (level, ...a) => {
      const m = a.map(x => (typeof x === 'string' ? x : x && x.message ? x.message : '')).join(' ').replace(/\s+/g, ' ').trim();
      if (!m) return;
      if (level === 'error' || /bootstrap|consensus|microdesc|guard|circuit|directory|ready|snapshot|connect/i.test(m)) set(id, null, m);
    },
  });
}

// ── layer 1: the Nym mixnet (one tunnel per page; Nym can't reopen it without a reload) ──
let nymP = null, nymDead = null;
function nym() {
  if (nymDead) return Promise.reject(nymDead);
  return nymP || (nymP = (async () => {
    const t0 = performance.now();
    set('nym', 'connecting', 'Loading the mixnet client (about 18 MB, once per visit)');
    const mt = await import('@nymproject/mix-tunnel');
    set('nym', 'connecting', 'Joining the Nym mixnet: entry gateway, 3 mix layers, exit gateway');
    await withTimeout(mt.setupMixTunnel({ connectTimeoutMs: 45000 }), 120000, 'mixnet setup');
    const h = await mt.getMixTunnel();
    const { MixWebSocket } = await import('./vendor/mix-websocket/index.js');
    set('nym', 'ready', 'Mixnet tunnel up in ' + secs(t0));
    return { h, MixWebSocket };
  })().catch(e => {
    nymDead = new Error('Nym tunnel failed: ' + errText(e) + '. Reload the page to retry.');
    set('nym', 'failed', nymDead.message);
    throw nymDead;
  }));
}

// ── layer 2: Tor whose relay connections travel inside the mixnet ──
let chainP = null;
function torChain() {
  return chainP || (chainP = (async () => {
    const n = await nym();
    const T = await torLib();
    const t0 = performance.now();
    set('relay', 'connecting', 'Opening ' + new URL(CFG.wispUrl).host + ' through the mixnet');
    const ws = new n.MixWebSocket(CFG.wispUrl);
    await withTimeout(ws.opened(), 90000, 'relay through the mixnet');
    if (ws.readyState !== 1) throw new Error('the relay could not be reached through the mixnet');
    const wisp = new WispClient(ws);
    await withTimeout(wisp.ready, 60000, 'relay handshake');
    set('relay', 'ready', new URL(CFG.wispUrl).host + ' answered a Nym exit in ' + secs(t0));
    const provider = {
      gateway: null,
      async connect(target) {
        const { host, port } = parseTarget(target);
        return new T.ArtiSocket(streamParts(await wisp.connect(host, port)));
      },
      close() { wisp.close(); },
    };
    let bootstrap;
    try {
      set('tor', 'connecting', 'Fetching the signed Tor directory snapshot through the mixnet');
      const r = await withTimeout(n.h.mixFetch(CFG.bootstrapUrl, { method: 'GET', headers: { Accept: '*/*' } }), 120000, 'directory snapshot');
      const b = r && r.body;
      if (r.status === 200 && b && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) bootstrap = b;
    } catch (_) { /* fall back to fetching the directory from Tor itself */ }
    set('tor', 'connecting', bootstrap ? 'Snapshot received (' + (bootstrap.byteLength / 1048576).toFixed(1) + ' MB); building circuits inside the mixnet'
      : 'No snapshot: downloading the directory from Tor through the mixnet (slower)');
    const client = new T.TorClient({ socketProvider: provider, bootstrap, storage: torStorage(T, 'veil-tor-chain'), log: torLog(T, 'tor'), logLevel: 'info' });
    await withTimeout(client.ready(), 15 * 60000, 'Tor bootstrap through the mixnet');
    set('tor', 'ready', 'Tor ready inside the mixnet after ' + secs(t0));
    return client;
  })().catch(e => {
    chainP = null;
    const which = layers.relay.state === 'ready' ? 'tor' : 'relay';
    set(which, 'failed', errText(e));
    throw e;
  }));
}

// ── Tor alone, through the tor-js gateway ──
let gwP = null;
function torGateway() {
  return gwP || (gwP = (async () => {
    const T = await torLib();
    const t0 = performance.now();
    set('torgw', 'connecting', 'Reaching Tor through the bridge gateway');
    const client = new T.TorClient({ gateway: CFG.torGateway, storage: torStorage(T, 'veil-tor'), log: torLog(T, 'torgw'), logLevel: 'info' });
    await withTimeout(client.ready(), 3 * 60000, 'Tor bootstrap');
    set('torgw', 'ready', 'Tor ready in ' + secs(t0));
    return client;
  })().catch(e => { gwP = null; set('torgw', 'failed', errText(e)); throw e; }));
}

async function readCapped(res, max) {
  if (!res.body) return new Uint8Array(0);
  const r = res.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { r.cancel(); } catch (_) {} throw new Error('response larger than ' + Math.round(max / 1048576) + ' MB'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

async function viaTor(client, url, o) {
  const res = await client.fetch(url, {
    method: o.method || 'GET', headers: o.headers || {}, body: o.body, signal: o.signal,
    anonOptions: o.isolationKey ? { isolationKey: o.isolationKey } : undefined,
  });
  return { status: res.status, statusText: res.statusText, headers: [...res.headers], body: await readCapped(res, o.maxBytes || 8388608) };
}
async function viaNym(url, o) {
  const { h } = await nym();
  const raw = await h.mixFetch(url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body });
  if (raw.body && raw.body.byteLength > (o.maxBytes || 8388608)) throw new Error('response too large');
  return { status: raw.status, statusText: raw.statusText, headers: raw.headers, body: raw.body || new Uint8Array(0) };
}

const ROUTE_LAYERS = { chain: ['nym', 'relay', 'tor'], tor: ['torgw'], nym: ['nym'] };

globalThis.VeilNet = {
  live: true,
  version: '1.0',
  config: CFG,
  routeLayers: mode => (ROUTE_LAYERS[mode] || []).slice(),
  layers: () => JSON.parse(JSON.stringify(layers)),
  logs: () => logs.slice(),
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  // Bring a route up (idempotent). Rejects if any of its layers fails: there is no fallback.
  async open(mode) {
    if (mode === 'chain') await torChain();
    else if (mode === 'tor') await torGateway();
    else if (mode === 'nym') await nym();
    else throw new Error('unknown route ' + mode);
  },
  // One HTTP request through a route. opts: {method, headers, body, isolationKey, signal, maxBytes, timeoutMs}
  async fetch(mode, url, opts = {}) {
    const run = mode === 'chain' ? torChain().then(c => viaTor(c, url, opts))
      : mode === 'tor' ? torGateway().then(c => viaTor(c, url, opts))
      : mode === 'nym' ? viaNym(url, opts)
      : Promise.reject(new Error('unknown route ' + mode));
    return withTimeout(run, opts.timeoutMs || 120000, 'request');
  },
  // Which IP the destination sees for this site, asked through the same circuit the site uses.
  async exit(mode, isolationKey) {
    const r = await this.fetch(mode, CFG.checkUrl, { isolationKey, headers: { Accept: 'application/json' }, maxBytes: 65536, timeoutMs: 120000 });
    const j = JSON.parse(new TextDecoder().decode(r.body));
    return { ip: j.IP, isTor: !!j.IsTor };
  },
  // Nym's tunnel is one per page, so a new Nym exit needs a reload; Tor routes rotate per site with isolation keys.
  rotatesInPlace: mode => mode !== 'nym',
};
if (typeof globalThis.__veilNetResolve === 'function') globalThis.__veilNetResolve(globalThis.VeilNet);
