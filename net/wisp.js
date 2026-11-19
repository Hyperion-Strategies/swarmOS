// Wisp v1 client: many TCP streams multiplexed over one WebSocket.
// Spec: https://github.com/MercuryWorkshop/wisp-protocol (protocol.md)
//
// Works over anything WebSocket-shaped: a browser WebSocket, Node's WebSocket,
// or Nym's MixWebSocket (which tunnels the WebSocket itself through the mixnet).
// Veil uses it to carry Tor relay connections, so the Wisp relay only ever
// sees a Nym exit on one side and Tor-encrypted bytes to a Tor guard on the other.

const T_CONNECT = 0x01, T_DATA = 0x02, T_CONTINUE = 0x03, T_CLOSE = 0x04, T_INFO = 0x05;
const STREAM_TCP = 0x01;
const MAX_PAYLOAD = 16 * 1024;

export const CLOSE_REASONS = {
  0x01: 'unspecified', 0x02: 'closed', 0x03: 'network error', 0x04: 'incompatible extensions',
  0x41: 'invalid destination', 0x42: 'unreachable host', 0x43: 'connection timed out', 0x44: 'connection refused',
  0x47: 'transfer timed out', 0x48: 'destination blocked by the relay', 0x49: 'throttled by the relay',
  0x81: 'client error',
};

function packet(type, id, payload) {
  const p = new Uint8Array(5 + (payload ? payload.byteLength : 0));
  const dv = new DataView(p.buffer);
  dv.setUint8(0, type); dv.setUint32(1, id, true);
  if (payload) p.set(payload, 5);
  return p;
}

export class WispClient {
  // ws: an object with send(data), close(), addEventListener('message'|'close'|'error').
  // If it is a browser WebSocket, set binaryType = 'arraybuffer' before passing it.
  constructor(ws, { log } = {}) {
    this.ws = ws;
    this.log = log || (() => {});
    this.streams = new Map();
    this.nextId = 1;
    this.initialCredit = 0;
    this.closed = false;
    this.onshutdown = null;   // (reason) => void, called once when the session ends for any reason
    this.ready = new Promise((resolve, reject) => { this._ready = resolve; this._fail = reject; });
    this.ready.catch(() => {});   // a session that dies before anyone awaits ready must not become an unhandled rejection
    this._onMessage = e => this._message(e.data);
    this._onClose = () => this._shutdown('relay connection closed');
    this._onError = () => this._shutdown('relay connection failed');
    ws.addEventListener('message', this._onMessage);
    ws.addEventListener('close', this._onClose);
    ws.addEventListener('error', this._onError);
  }

  _message(data) {
    if (typeof data === 'string' || !data) return;
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (u8.byteLength < 5) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const type = dv.getUint8(0), id = dv.getUint32(1, true), body = u8.subarray(5);
    if (id === 0) {
      if (type === T_CONTINUE && body.byteLength >= 4) {
        this.initialCredit = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
        this._ready(this.initialCredit);
      } else if (type === T_CLOSE) {
        this._shutdown('relay refused the session (' + (CLOSE_REASONS[body[0]] || body[0]) + ')');
      } else if (type === T_INFO) {
        // v2 servers only send INFO when the client asked for v2 via Sec-WebSocket-Protocol. We never do.
        this._shutdown('relay requires Wisp v2');
      }
      return;
    }
    const s = this.streams.get(id);
    if (!s) return;
    if (type === T_DATA) s._data(body.slice());
    else if (type === T_CONTINUE && body.byteLength >= 4) s._credit(new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true));
    else if (type === T_CLOSE) s._closed(body.byteLength ? body[0] : 0x01, true);
  }

  _send(bytes) {
    if (this.closed) throw new Error('relay connection closed');
    return this.ws.send(bytes);
  }

  _shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this._fail(new Error(reason));
    for (const s of [...this.streams.values()]) s._closed(0x03, false, reason);
    this.streams.clear();
    this.ws.removeEventListener('message', this._onMessage);
    this.ws.removeEventListener('close', this._onClose);
    this.ws.removeEventListener('error', this._onError);
    if (this.onshutdown) { try { this.onshutdown(reason); } catch (_) {} }
  }

  // Open a TCP stream. Returns a WispStream immediately; data may be written at once (the spec allows it).
  async connect(host, port) {
    await this.ready;
    if (this.closed) throw new Error('relay connection closed');
    const id = this.nextId++;
    if (this.nextId > 0xfffffff0) this.nextId = 1;
    const s = new WispStream(this, id, this.initialCredit);
    this.streams.set(id, s);
    const name = new TextEncoder().encode(host);
    const payload = new Uint8Array(3 + name.byteLength);
    payload[0] = STREAM_TCP;
    new DataView(payload.buffer).setUint16(1, port, true);
    payload.set(name, 3);
    await this._send(packet(T_CONNECT, id, payload));
    return s;
  }

  close() {
    this._shutdown('closed by client');
    try { const r = this.ws.close(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) {}   // MixWebSocket.close() is async
  }
}

export class WispStream {
  constructor(client, id, credit) {
    this.client = client; this.id = id; this.credit = credit;
    this.waiters = [];
    this.done = false;
    this.ondata = null;      // (Uint8Array) => void
    this.onclose = null;     // ({ok, reason}) => void
    this.pending = [];       // data that arrived before ondata was set
  }
  _data(u8) { if (this.ondata) this.ondata(u8); else this.pending.push(u8); }
  _credit(n) { this.credit = n; const w = this.waiters; this.waiters = []; w.forEach(f => f()); }
  _closed(code, fromRemote, why) {
    if (this.done) return;
    this.done = true;
    this.client.streams.delete(this.id);
    const w = this.waiters; this.waiters = []; w.forEach(f => f());
    this.closeInfo = { ok: code === 0x02, code, reason: why || CLOSE_REASONS[code] || ('code ' + code), remote: fromRemote };
    if (this.onclose) this.onclose(this.closeInfo);
  }
  setReader(ondata, onclose) {
    this.ondata = ondata; this.onclose = onclose;
    const p = this.pending; this.pending = [];
    p.forEach(ondata);
    if (this.done && onclose) onclose(this.closeInfo);
  }
  async write(u8) {
    for (let off = 0; off < u8.byteLength; off += MAX_PAYLOAD) {
      while (this.credit <= 0 && !this.done) await new Promise(r => this.waiters.push(r));
      if (this.done) throw new Error('stream closed');
      this.credit--;
      await this.client._send(packet(T_DATA, this.id, u8.subarray(off, Math.min(off + MAX_PAYLOAD, u8.byteLength))));
    }
  }
  close(code = 0x02) {
    if (this.done) return;
    try { this.client._send(packet(T_CLOSE, this.id, new Uint8Array([code]))); } catch (_) {}
    this._closed(code, false);
  }
}

// A WispStream as WHATWG streams: the shape tor-js's ArtiSocket is built from.
export function streamParts(s) {
  let resolveClosed;
  const closed = new Promise(r => { resolveClosed = r; });
  const readable = new ReadableStream({
    start(c) {
      s.setReader(
        u8 => { try { c.enqueue(u8); } catch (_) {} },
        info => { try { c.close(); } catch (_) {} resolveClosed({ ok: info.ok, reason: info.ok ? undefined : info.reason }); },
      );
    },
    cancel() { s.close(0x02); },
  });
  const writable = new WritableStream({
    write: chunk => s.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)),
    close: () => {},           // Wisp has no half-close; the stream ends when either side closes it
    abort: () => s.close(0x02),
  });
  return { readable, writable, closed, closeWrite: async () => {}, close: () => s.close(0x02) };
}
