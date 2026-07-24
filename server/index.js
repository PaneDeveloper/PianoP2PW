const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));

// rooms: Map<roomId, Map<peerId, { ws, name }>>
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastUserList(roomId) {
  const room = getRoom(roomId);
  const users = [...room.entries()].map(([id, p]) => ({ id, name: p.name }));
  room.forEach((p) => send(p.ws, { type: 'user-list', users }));
}

wss.on('connection', (ws) => {
  const peerId = randomUUID();
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignora mensagens mal formadas
    }

    if (msg.type === 'join') {
      const roomId = String(msg.room || '').toUpperCase().slice(0, 8);
      if (!roomId) return;

      currentRoom = roomId;
      const room = getRoom(roomId);

      // avisa quem já está na sala que alguém novo chegou (eles iniciam a conexão)
      room.forEach((p) => send(p.ws, { type: 'peer-joined', id: peerId, name: msg.name }));

      room.set(peerId, { ws, name: msg.name || 'Anônimo' });

      send(ws, {
        type: 'joined',
        id: peerId,
        room: roomId,
        peers: [...room.entries()]
          .filter(([id]) => id !== peerId)
          .map(([id, p]) => ({ id, name: p.name })),
      });

      broadcastUserList(roomId);
      return;
    }

    if (msg.type === 'signal' && currentRoom) {
      // relay de oferta/resposta/ICE candidate entre dois peers da mesma sala
      const room = getRoom(currentRoom);
      const target = room.get(msg.target);
      if (target) send(target.ws, { type: 'signal', from: peerId, data: msg.data });
      return;
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.delete(peerId);
    room.forEach((p) => send(p.ws, { type: 'peer-left', id: peerId }));
    broadcastUserList(currentRoom);
    if (room.size === 0) rooms.delete(currentRoom);
  });
});

server.listen(PORT, () => {
  console.log(`🎹 Piano P2P rodando em http://localhost:${PORT}`);
});
