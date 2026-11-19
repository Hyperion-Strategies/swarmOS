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
// Reject after ms; if an AbortController is given, abort it too so the request underneath actually stops.
function withTimeout(p, ms, what, ac) {
  let t;
  return Promise.race([p, new Promise((_, j) => { t = setTimeout(() => { j(new Error(what + ' (timed out after ' + Math.round(ms / 1000) + ' s)')); if (ac) ac.abort(); }, ms); })]).finally(() => clearTimeout(t));
}
const quietly = f => { try { const r = f(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) {} };
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
let nymP = null, nymDead = null, nymMod = null;
function nym() {
  if (nymDead) return Promise.reject(nymDead);
  return nymP || (nymP = (async () => {
    const t0 = performance.now();
    set('nym', 'connecting', 'Loading the mixnet client (about 18 MB, once per visit)');
    const mt = nymMod = await import('@nymproject/mix-tunnel');
    set('nym', 'connecting', 'Joining the Nym mixnet: entry gateway, 3 mix layers, exit gateway');
    // maxRedirects 0: mixFetch hands every 3xx back to Veil instead of following it inside the worker, so Veil sees
    // each hop (address bar, base URL for links, HTTPS check) exactly as it does on the Tor routes
    await withTimeout(mt.setupMixTunnel({ connectTimeoutMs: 45000, maxRedirects: 0 }), 120000, 'mixnet setup');
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
// After something on the mixnet fails: is the tunnel itself gone? It can't be reopened without a reload, so say so.
async function nymCheck() {
  if (!nymMod || nymDead || typeof nymMod.getTunnelState !== 'function') return;
  try {
    const s = await nymMod.getTunnelState();
    if (s && (s.state === 'failed' || s.state === 'shutdown')) {
      nymDead = new Error('The Nym tunnel closed' + (s.reason && s.reason.kind ? ' (' + s.reason.kind + ')' : '') + '. Reload the page to rejoin the mixnet.');
      set('nym', 'failed', nymDead.message);
    }
  } catch (_) {}
}

// ── layer 2: Tor whose relay connections travel inside the mixnet ──
let chainP = null;
function torChain() {
  if (chainP) return chainP;
  let ws = null, wisp = null, client = null;
  const me = chainP = (async () => {
    const n = await nym();
    const T = await torLib();
    const t0 = performance.now();
    set('relay', 'connecting', 'Opening ' + new URL(CFG.wispUrl).host + ' through the mixnet');
    ws = new n.MixWebSocket(CFG.wispUrl);
    await withTimeout(ws.opened(), 90000, 'relay through the mixnet');
    if (ws.readyState !== 1) throw new Error('the relay could not be reached through the mixnet');
    wisp = new WispClient(ws);
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
    client = new T.TorClient({ socketProvider: provider, bootstrap, storage: torStorage(T, 'veil-tor-chain'), log: torLog(T, 'tor'), logLevel: 'info' });
    await withTimeout(client.ready(), 15 * 60000, 'Tor bootstrap through the mixnet');
    set('tor', 'ready', 'Tor ready inside the mixnet after ' + secs(t0));
    // Every Tor relay connection rides this one relay session. If it drops, the client is dead: say so, and build a
    // fresh chain on the next request instead of letting every request time out against a dead socket.
    wisp.onshutdown = reason => {
      if (chainP !== me) return;
      chainP = null;
      quietly(() => client.close());
      set('relay', 'failed', 'The relay connection closed (' + reason + '). Veil rebuilds the route on the next page.');
      set('tor', 'idle', '');
      nymCheck();
    };
    return client;
  })().catch(e => {
    if (chainP === me) chainP = null;
    // tear down whatever got built, so a retry starts clean instead of stacking a second set of connections
    if (client) quietly(() => client.close());
    if (wisp) quietly(() => wisp.close());
    else if (ws) quietly(() => ws.close());
    const which = layers.relay.state === 'ready' ? 'tor' : 'relay';
    set(which, 'failed', errText(e));
    nymCheck();
    throw e;
  });
  return me;
}

// ── Tor alone, through the tor-js gateway ──
let gwP = null;
function torGateway() {
  if (gwP) return gwP;
  let client = null;
  const me = gwP = (async () => {
    const T = await torLib();
    const t0 = performance.now();
    set('torgw', 'connecting', 'Reaching Tor through the bridge gateway');
    client = new T.TorClient({ gateway: CFG.torGateway, storage: torStorage(T, 'veil-tor'), log: torLog(T, 'torgw'), logLevel: 'info' });
    await withTimeout(client.ready(), 3 * 60000, 'Tor bootstrap');
    set('torgw', 'ready', 'Tor ready in ' + secs(t0));
    return client;
  })().catch(e => {
    if (gwP === me) gwP = null;
    if (client) quietly(() => client.close());     // a retry gets a fresh client, not a second one beside a stuck one
    set('torgw', 'failed', errText(e));
    throw e;
  });
  return me;
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
  let raw;
  try { raw = await h.mixFetch(url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body }); }
  catch (e) { nymCheck(); throw e; }
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
    // One controller per request: the caller's signal (navigation stopped) and the timeout both abort the request
    // itself on the Tor routes. mixFetch can't be cancelled, so on Nym the caller just stops waiting.
    const ac = new AbortController();
    if (opts.signal) { if (opts.signal.aborted) ac.abort(); else opts.signal.addEventListener('abort', () => ac.abort(), { once: true }); }
    const o = Object.assign({}, opts, { signal: ac.signal });
    const run = mode === 'chain' ? torChain().then(c => viaTor(c, url, o))
      : mode === 'tor' ? torGateway().then(c => viaTor(c, url, o))
      : mode === 'nym' ? viaNym(url, o)
      : Promise.reject(new Error('unknown route ' + mode));
    const stopped = new Promise((_, j) => {
      const no = () => j(new DOMException('The request was stopped', 'AbortError'));
      if (ac.signal.aborted) no(); else ac.signal.addEventListener('abort', no, { once: true });
    });
    stopped.catch(() => {});
    return withTimeout(Promise.race([run, stopped]), opts.timeoutMs || 120000, 'request', ac);
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
