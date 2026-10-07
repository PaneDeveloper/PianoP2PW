// Controle Remoto - rede.
// Host (TV/PC) <-> controles (celular/tablet). As notas vão por WebRTC DataChannel (direto, baixa
// latência) e, enquanto o canal direto não abre (ou se ele falhar), caem automaticamente pro
// servidor via WebSocket. Reconecta sozinho se a conexão cair.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const FATAL = new Set(['bad-code', 'full', 'too-many', 'taken']);
const GIVE_UP_MS = 120000;

export const normalizeCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// espera o ICE terminar de coletar candidatos (assim a oferta/resposta vai completa, sem "trickle")
function iceDone(pc, ms = 2500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(finish, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

const validNote = (m) => Number.isInteger(m) && m >= 21 && m <= 108;

export class RemoteLink extends EventTarget {
  constructor() {
    super();
    this.role = null;        // 'host' | 'controller'
    this.code = null;
    this.id = null;
    this.emoji = null;
    this.count = 0;
    this.hostOnline = false;
    this.direct = false;     // controle: canal WebRTC direto aberto?
    this.ws = null;
    this.pc = null;          // controle: conexão com o host
    this.dc = null;
    this.peers = new Map();  // host: id -> { pc, dc, emoji }
    this.stopped = false;
    this._ever = false;
    this._retry = 0;
    this._since = 0;
    this._timer = null;
    this._ping = null;
    this._err = null;
  }

  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  // ---------- API pública ----------
  host(code = null) {
    this.role = 'host';
    this.code = normalizeCode(code) || null;
    return this._connect();
  }

  join(code, emoji = null) {
    this.role = 'controller';
    this.code = normalizeCode(code);
    this.emoji = emoji;
    return this._connect();
  }

  // controle -> manda a nota (retorna por onde foi: 'p2p' ou 'ws')
  sendNote(m) {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify({ m }));
      return 'p2p';
    }
    this._send({ type: 'remote-note', m });
    return 'ws';
  }

  end() { this._send({ type: 'remote-end' }); this.stopped = true; this._cleanup(); } // host encerra a sala
  leave() { this.stopped = true; this._cleanup(); }                                   // controle sai

  // chamar quando a aba volta do segundo plano: se a conexão morreu, reconecta já
  kick() {
    if (this.stopped || !this._ever) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this._timer);
    this._connect().catch(() => {});
  }

  // ---------- WebSocket ----------
  _connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      this._err = null;

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      this.ws = ws;

      ws.onopen = () => {
        this._send(this.role === 'host'
          ? { type: 'remote-host', code: this.code }
          : { type: 'remote-join', code: this.code, emoji: this.emoji });
      };

      ws.onmessage = (ev) => {
        if (ws !== this.ws) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this._onMessage(msg, settle, resolve, reject);
      };

      ws.onclose = () => {
        if (ws !== this.ws) return;
        clearInterval(this._ping);
        this._dropAllPeers();
        if (this.stopped) return;
        settle(reject, new Error(this._err || 'offline'));
        if (this._ever) this._reconnect();
      };
    });
  }

  _up() {
    this._ever = true;
    this._retry = 0;
    this._since = 0;
    clearInterval(this._ping);
    this._ping = setInterval(() => this._send({ type: 'remote-ping' }), 25000);
    this._emit('status', { state: 'online' });
  }

  _reconnect() {
    if (this._err && FATAL.has(this._err)) return this._finish(this._err);
    if (!this._since) this._since = Date.now();
    if (Date.now() - this._since > GIVE_UP_MS) return this._finish('timeout');
    this._emit('status', { state: 'reconnecting' });
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (!this.stopped) this._connect().catch(() => {});
    }, Math.min(1000 * ++this._retry, 5000));
  }

  _finish(reason) {
    this.stopped = true;
    this._cleanup();
    this._emit('closed', { reason });
  }

  _cleanup() {
    clearTimeout(this._timer);
    clearInterval(this._ping);
    this._dropAllPeers();
    try { this.ws?.close(); } catch { /* já fechado */ }
  }

  _onMessage(msg, settle, resolve, reject) {
    switch (msg.type) {
      case 'remote-hosted':
        this.code = msg.code;
        this.count = msg.count | 0;
        this._up();
        settle(resolve, { code: this.code });
        this._emit('count', { count: this.count });
        break;

      case 'remote-joined':
        this.id = msg.id;
        this.emoji = msg.emoji;
        this.count = msg.count | 0;
        this.hostOnline = !!msg.hostOnline;
        this._up();
        settle(resolve, { id: this.id, emoji: this.emoji, count: this.count, hostOnline: this.hostOnline });
        this._emit('count', { count: this.count });
        this._emit('host', { online: this.hostOnline });
        break;

      case 'remote-count':
        this.count = msg.count | 0;
        this._emit('count', { count: this.count });
        break;

      case 'remote-peer': // host: chegou um controle novo -> abre o canal direto com ele
        if (this.role === 'host') this._offerTo(msg.id, msg.emoji);
        break;

      case 'remote-peer-left':
        this._dropPeer(msg.id);
        break;

      case 'remote-note': // nota que veio pelo servidor (plano B)
        if (this.role === 'host' && validNote(msg.m)) this._emit('note', { m: msg.m, emoji: msg.emoji, id: msg.id });
        break;

      case 'remote-signal':
        if (this.role === 'host') this._hostSignal(msg.from, msg.data);
        else this._ctrlSignal(msg.data);
        break;

      case 'remote-host': // controle: o host caiu / voltou
        this.hostOnline = !!msg.online;
        if (!msg.online) this._closePc();
        this._emit('host', { online: this.hostOnline });
        break;

      case 'remote-closed':
        this._finish('ended');
        break;

      case 'remote-error':
        this._err = msg.reason;
        settle(reject, new Error(msg.reason));
        try { this.ws.close(); } catch { /* ignore */ }
        break;
    }
  }

  // ---------- WebRTC: lado do host ----------
  async _offerTo(id, emoji) {
    this._dropPeer(id);
    if (typeof RTCPeerConnection === 'undefined') return; // fica só no plano B (servidor)
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, dc: null, emoji };
    this.peers.set(id, peer);

    const dc = pc.createDataChannel('notes', { ordered: false });
    peer.dc = dc;
    dc.onmessage = (e) => {
      try {
        const { m } = JSON.parse(e.data);
        if (validNote(m)) this._emit('note', { m, emoji: peer.emoji, id });
      } catch { /* payload inválido */ }
    };

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await iceDone(pc);
      if (this.peers.get(id) !== peer) return; // já foi substituído/removido
      this._send({ type: 'remote-signal', target: id, data: { sdp: pc.localDescription } });
    } catch { /* sem canal direto: o servidor segura a onda */ }
  }

  _hostSignal(from, data) {
    const peer = this.peers.get(from);
    if (peer && data?.sdp) peer.pc.setRemoteDescription(data.sdp).catch(() => {});
  }

  _dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    try { peer.dc?.close(); peer.pc.close(); } catch { /* ignore */ }
  }

  _dropAllPeers() {
    [...this.peers.keys()].forEach((id) => this._dropPeer(id));
    this._closePc();
  }

  // ---------- WebRTC: lado do controle ----------
  async _ctrlSignal(data) {
    if (!data?.sdp || typeof RTCPeerConnection === 'undefined') return;
    this._closePc();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.ondatachannel = (e) => {
      if (this.pc !== pc) return;
      const dc = e.channel;
      dc.onopen = () => { if (this.pc === pc) { this.dc = dc; this.direct = true; this._emit('status', { state: 'online' }); } };
      dc.onclose = () => { if (this.dc === dc) { this.dc = null; this.direct = false; this._emit('status', { state: 'online' }); } };
    };

    try {
      await pc.setRemoteDescription(data.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await iceDone(pc);
      if (this.pc !== pc) return;
      this._send({ type: 'remote-signal', data: { sdp: pc.localDescription } });
    } catch { /* continua pelo servidor */ }
  }

  _closePc() {
    const had = this.direct;
    try { this.dc?.close(); this.pc?.close(); } catch { /* ignore */ }
    this.dc = null;
    this.pc = null;
    this.direct = false;
    if (had) this._emit('status', { state: 'online' });
  }
}
