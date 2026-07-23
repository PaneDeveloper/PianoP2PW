// Cliente de sinalização (fala com o servidor Node via WebSocket)
export class SignalingClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.id = null;
    this.room = null;
  }

  connect(room, name) {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${protocol}://${location.host}`);
      this.room = room;

      this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'join', room, name }));

      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'joined') {
          this.id = msg.id;
          resolve(msg);
        }
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      };

      this.ws.onerror = (err) => reject(err);
      this.ws.onclose = () => this.dispatchEvent(new CustomEvent('closed'));
    });
  }

  sendSignal(target, data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', target, data }));
    }
  }

  disconnect() {
    this.ws?.close();
  }
}

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Gerencia as conexões WebRTC ponto-a-ponto (uma malha: todo mundo conecta com todo mundo)
export class PeerMesh extends EventTarget {
  constructor(signaling) {
    super();
    this.signaling = signaling;
    this.peers = new Map(); // id -> { pc, channel, name }
    this._onMessage = (e) => this._handleSignal(e.detail);
    signaling.addEventListener('message', this._onMessage);
  }

  async _connectTo(id, name, initiator) {
    if (this.peers.has(id)) return this.peers.get(id);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, channel: null, name };
    this.peers.set(id, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.sendSignal(id, { candidate: e.candidate });
    };

    pc.ondatachannel = (e) => {
      entry.channel = e.channel;
      this._bindChannel(id, entry);
    };

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this.removePeer(id);
      }
    };

    if (initiator) {
      // canal não-confiável e sem ordem: prioriza latência baixa (ótimo para notas musicais)
      const channel = pc.createDataChannel('notes', { ordered: false, maxRetransmits: 0 });
      entry.channel = channel;
      this._bindChannel(id, entry);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendSignal(id, { sdp: pc.localDescription });
    }

    return entry;
  }

  _bindChannel(id, entry) {
    entry.channel.onopen = () =>
      this.dispatchEvent(new CustomEvent('peer-connected', { detail: { id, name: entry.name } }));
    entry.channel.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        this.dispatchEvent(new CustomEvent('note', { detail: data }));
      } catch { /* ignora payloads inválidos */ }
    };
    entry.channel.onclose = () => this.removePeer(id);
  }

  async _handleSignal(msg) {
    if (msg.type === 'peer-joined') {
      await this._connectTo(msg.id, msg.name, true);
    } else if (msg.type === 'peer-left') {
      this.removePeer(msg.id);
    } else if (msg.type === 'signal') {
      const { from, data } = msg;
      let entry = this.peers.get(from) || (await this._connectTo(from, '?', false));
      const pc = entry.pc;

      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signaling.sendSignal(from, { sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          console.warn('Falha ao adicionar ICE candidate', err);
        }
      }
    }
  }

  removePeer(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    entry.pc.close();
    this.peers.delete(id);
    this.dispatchEvent(new CustomEvent('peer-disconnected', { detail: { id } }));
  }

  broadcast(data) {
    const json = JSON.stringify(data);
    this.peers.forEach((entry) => {
      if (entry.channel?.readyState === 'open') entry.channel.send(json);
    });
  }

  closeAll() {
    this.peers.forEach((_, id) => this.removePeer(id));
  }
}
