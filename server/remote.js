// Controle Remoto: TV/PC (host) + celulares/tablets (controles) na mesma sessão.
// O servidor só guarda quem está em qual sessão (em memória) e repassa mensagens.
const { WebSocket } = require('ws');
const { randomBytes } = require('crypto');

// sem 0/O/1/I pra ninguém errar na hora de digitar
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 10;
const CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;
const MAX_CONTROLLERS = 20;
const MAX_FAILED_JOINS = 6;
const HOST_GRACE_MS = 90_000; // se a TV cair, a sala espera esse tempo antes de fechar

const ANIMALS = ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆'];

// code -> { host: ws|null, controllers: Map<peerId, { ws, emoji }>, timer }
const sessions = new Map();

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newCode() {
  let code;
  do {
    code = Array.from(randomBytes(CODE_LEN), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (sessions.has(code));
  return code;
}

function broadcastCount(s) {
  const msg = { type: 'remote-count', count: s.controllers.size };
  send(s.host, msg);
  s.controllers.forEach((c) => send(c.ws, msg));
}

function endSession(code) {
  const s = sessions.get(code);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(code);
  s.controllers.forEach((c) => send(c.ws, { type: 'remote-closed' }));
}

// no máx. ~40 notas/seg por controle (humano nenhum chega nisso)
function noteRateOk(ws) {
  const now = Date.now();
  if (now - (ws._rt || 0) > 1000) { ws._rt = now; ws._rc = 0; }
  return ++ws._rc <= 40;
}

// Cria o "handler" de uma conexão. handle(msg) devolve true se a mensagem era do controle remoto.
function createRemoteHandler(ws, peerId) {
  let role = null; // 'host' | 'controller'
  let code = null;
  let failedJoins = 0;

  function fail(reason) {
    send(ws, { type: 'remote-error', reason });
    if (++failedJoins >= MAX_FAILED_JOINS) {
      send(ws, { type: 'remote-error', reason: 'too-many' });
      ws.close();
    }
  }

  function host(msg) {
    if (role) return;
    let wanted = normCode(msg.code);
    let s;
    if (CODE_RE.test(wanted)) {
      // reconexão da TV/PC (ou refresh): reaproveita o mesmo código
      s = sessions.get(wanted);
      if (s && s.host && s.host !== ws && s.host.readyState === WebSocket.OPEN) {
        send(ws, { type: 'remote-error', reason: 'taken' });
        return;
      }
    } else {
      wanted = newCode();
    }
    if (!s) {
      s = { host: null, controllers: new Map(), timer: null };
      sessions.set(wanted, s);
    }
    clearTimeout(s.timer);
    s.host = ws;
    role = 'host';
    code = wanted;
    ws.remoteRole = 'host';
    send(ws, { type: 'remote-hosted', code, count: s.controllers.size });
    // quem já estava na sala (host caiu e voltou) é reapresentado pro host
    s.controllers.forEach((c, id) => {
      send(ws, { type: 'remote-peer', id, emoji: c.emoji });
      send(c.ws, { type: 'remote-host', online: true });
    });
  }

  function join(msg) {
    if (role) return;
    const wanted = normCode(msg.code);
    const s = CODE_RE.test(wanted) ? sessions.get(wanted) : null;
    if (!s) return fail('not-found');
    if (s.controllers.size >= MAX_CONTROLLERS) {
      send(ws, { type: 'remote-error', reason: 'full' });
      return;
    }
    const used = new Set([...s.controllers.values()].map((c) => c.emoji));
    let emoji = ANIMALS.includes(msg.emoji) && !used.has(msg.emoji) ? msg.emoji : null;
    if (!emoji) {
      const free = ANIMALS.filter((e) => !used.has(e));
      const pool = free.length ? free : ANIMALS;
      emoji = pool[Math.floor(Math.random() * pool.length)];
    }
    s.controllers.set(peerId, { ws, emoji });
    role = 'controller';
    code = wanted;
    ws.remoteRole = 'controller';
    send(ws, { type: 'remote-joined', id: peerId, emoji, count: s.controllers.size, hostOnline: !!s.host });
    send(s.host, { type: 'remote-peer', id: peerId, emoji });
    broadcastCount(s);
  }

  function handle(msg) {
    if (typeof msg.type !== 'string' || !msg.type.startsWith('remote-')) return false;

    if (msg.type === 'remote-host') host(msg);
    else if (msg.type === 'remote-join') join(msg);
    else if (msg.type === 'remote-end' && role === 'host') {
      const c = code;
      role = null;
      code = null;
      endSession(c);
    } else if (msg.type === 'remote-note' && role === 'controller') {
      const m = msg.m;
      if (!Number.isInteger(m) || m < 21 || m > 108 || !noteRateOk(ws)) return true;
      const s = sessions.get(code);
      const me = s && s.controllers.get(peerId);
      if (s && s.host && me) send(s.host, { type: 'remote-note', id: peerId, emoji: me.emoji, m });
    } else if (msg.type === 'remote-signal' && role && msg.data && typeof msg.data === 'object') {
      // relay de oferta/resposta WebRTC (host <-> controle), nunca entre controles
      const s = sessions.get(code);
      if (!s) return true;
      if (role === 'host') {
        const c = s.controllers.get(msg.target);
        if (c) send(c.ws, { type: 'remote-signal', data: msg.data });
      } else if (s.host) {
        send(s.host, { type: 'remote-signal', from: peerId, data: msg.data });
      }
    }
    // 'remote-ping' só serve pra manter a conexão viva (proxies fecham WebSocket ocioso)
    return true;
  }

  function leave() {
    if (!role) return;
    const c = code;
    const s = sessions.get(c);
    if (!s) return;
    if (role === 'host') {
      if (s.host !== ws) return; // já foi substituído por uma reconexão
      s.host = null;
      s.controllers.forEach((ctl) => send(ctl.ws, { type: 'remote-host', online: false }));
      clearTimeout(s.timer);
      s.timer = setTimeout(() => endSession(c), HOST_GRACE_MS);
    } else {
      s.controllers.delete(peerId);
      send(s.host, { type: 'remote-peer-left', id: peerId });
      broadcastCount(s);
    }
  }

  return { handle, leave };
}

// ping/pong: derruba conexões "fantasma" (TV desligada da tomada, celular sem sinal...)
function startHeartbeat(wss, everyMs = 30_000) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  const t = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.remoteRole) return;
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, everyMs);
  t.unref();
}

module.exports = { createRemoteHandler, startHeartbeat };
