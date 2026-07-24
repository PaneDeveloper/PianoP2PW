import { SignalingClient, PeerMesh } from './webrtc.js';

// --- Registro do Service Worker ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('SW registrado com sucesso!'))
      .catch((err) => console.error('Falha ao registrar SW:', err));
  });
}

const ANIMALS = ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦆"];
const myEmoji = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
const myName = `Piano ${myEmoji}`;

let settings = {
  waveType: 'sine',
  octaveOffset: 0,
  volume: 0.8,
  sustain: 1.2,
  showTrails: true,
};

let isInteractionActive = false;
let lastTriggeredMidi = null;

const noteColors = ['#ff5252', '#ff5252', '#ffab40', '#ffab40', '#ffd740', '#69f0ae', '#69f0ae', '#40c4ff', '#40c4ff', '#7c4dff', '#7c4dff', '#ff4081'];

const notes = [
  { midi: 48, k: 'q', b: false }, { midi: 49, k: '2', b: true },
  { midi: 50, k: 'w', b: false }, { midi: 51, k: '3', b: true },
  { midi: 52, k: 'e', b: false }, { midi: 53, k: 'r', b: false },
  { midi: 54, k: '5', b: true }, { midi: 55, k: 't', b: false },
  { midi: 56, k: '6', b: true }, { midi: 57, k: 'y', b: false },
  { midi: 58, k: '7', b: true }, { midi: 59, k: 'u', b: false },
  { midi: 60, k: 'z', b: false }, { midi: 61, k: 's', b: true },
  { midi: 62, k: 'x', b: false }, { midi: 63, k: 'd', b: true },
  { midi: 64, k: 'c', b: false }, { midi: 65, k: 'v', b: false },
  { midi: 66, k: 'g', b: true }, { midi: 67, k: 'b', b: false },
  { midi: 68, k: 'h', b: true }, { midi: 69, k: 'n', b: false },
  { midi: 70, k: 'j', b: true }, { midi: 71, k: 'm', b: false },
  { midi: 72, k: ',', b: false },
];

const canvas = document.getElementById('visualizer');
const ctx = canvas.getContext('2d');
let trails = [];

window.onresize = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - 220;
};
window.onresize();

class NoteTrail {
  constructor(x, width, color) {
    this.x = x; this.width = width; this.color = color;
    this.y = canvas.height; this.h = 45; this.speed = 5;
    this.opacity = 1;
  }
  update() { this.y -= this.speed; this.opacity -= 0.005; }
  draw() {
    ctx.globalAlpha = Math.max(0, this.opacity);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(this.x + 4, this.y, this.width - 8, this.h, 8);
    else ctx.rect(this.x + 4, this.y, this.width - 8, this.h);
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }
}

function animate() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (settings.showTrails) {
    trails = trails.filter((t) => t.y + t.h > 0 && t.opacity > 0);
    trails.forEach((t) => { t.update(); t.draw(); });
  }
  requestAnimationFrame(animate);
}
animate();

function showEmojiPopup(keyEl, emoji) {
  if (!emoji) return;
  const r = keyEl.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'emoji-popup';
  el.textContent = emoji;
  el.style.left = (r.left + r.width / 2) + 'px';
  el.style.top = (r.top - 12) + 'px';
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.transform = 'translate(-50%, -40px)';
    el.style.opacity = '0';
  });
  setTimeout(() => el.remove(), 550);
}

let audioCtx = null;
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// --- Rede: BroadcastChannel (mesma aba/navegador) + Mesh WebRTC (outros dispositivos) ---
let currentBC = null;
let signaling = null;
let mesh = null;

function trigger(midiNote, broadcast = true, remoteWaveType = null, remoteEmoji = null) {
  initAudio();
  const wave = remoteWaveType || settings.waveType;
  const playerEmoji = broadcast ? myEmoji : remoteEmoji;
  const finalNote = midiNote + (settings.octaveOffset * 12);
  const freq = 440 * Math.pow(2, (finalNote - 69) / 12);

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = wave;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

  gain.gain.setValueAtTime(0, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(settings.volume * 0.2, audioCtx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + settings.sustain);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + settings.sustain + 0.1);

  const keyEl = document.querySelector(`[data-midi="${midiNote}"]`);
  if (keyEl) {
    keyEl.style.color = noteColors[finalNote % 12];
    keyEl.classList.add('active');
    setTimeout(() => {
      keyEl.classList.remove('active');
      keyEl.style.color = '';
    }, 150);
    if (settings.showTrails) {
      const r = keyEl.getBoundingClientRect();
      trails.push(new NoteTrail(r.left, r.width, noteColors[finalNote % 12]));
    }
    showEmojiPopup(keyEl, playerEmoji);
  }

  if (broadcast) {
    const data = { m: midiNote, w: settings.waveType, e: myEmoji };
    if (currentBC) currentBC.postMessage(data);
    if (mesh) mesh.broadcast(data);
  }
}

document.querySelectorAll('.inst-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.inst-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    settings.waveType = btn.dataset.type;
  };
});

const modal = document.getElementById('settings-modal');
const overlay = document.getElementById('modal-overlay');
document.getElementById('open-settings').onclick = () => { modal.style.display = 'block'; overlay.style.display = 'block'; };
const closeSettings = () => { modal.style.display = 'none'; overlay.style.display = 'none'; };
document.getElementById('close-settings').onclick = closeSettings;
document.getElementById('save-settings').onclick = closeSettings;

document.getElementById('volume-slider').oninput = (e) => {
  settings.volume = e.target.value / 100;
  document.getElementById('vol-display').textContent = e.target.value + '%';
};
document.getElementById('sustain-slider').oninput = (e) => {
  settings.sustain = parseFloat(e.target.value);
  document.getElementById('sustain-display').textContent = e.target.value + 's';
};
document.getElementById('trails-toggle').onchange = (e) => {
  settings.showTrails = e.target.checked;
};

const octVal = document.getElementById('octave-value');
function playTestNote() { trigger(60); }

document.getElementById('octave-down').onclick = () => {
  if (settings.octaveOffset > -2) {
    settings.octaveOffset--;
    octVal.textContent = settings.octaveOffset;
    drawKeys();
    playTestNote();
  }
};
document.getElementById('octave-up').onclick = () => {
  if (settings.octaveOffset < 2) {
    settings.octaveOffset++;
    octVal.textContent = settings.octaveOffset;
    drawKeys();
    playTestNote();
  }
};

window.addEventListener('mousedown', () => isInteractionActive = true);
window.addEventListener('mouseup', () => { isInteractionActive = false; lastTriggeredMidi = null; });
window.addEventListener('touchstart', (e) => { isInteractionActive = true; handlePointer(e); }, { passive: false });
window.addEventListener('touchend', () => { isInteractionActive = false; lastTriggeredMidi = null; });
window.addEventListener('touchmove', handlePointer, { passive: false });

function handlePointer(e) {
  if (!isInteractionActive) return;
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const y = e.touches ? e.touches[0].clientY : e.clientY;
  const el = document.elementFromPoint(x, y)?.closest('.key');
  if (el) {
    const midi = parseInt(el.dataset.midi);
    if (midi !== lastTriggeredMidi) {
      trigger(midi);
      lastTriggeredMidi = midi;
    }
  }
}

const pianoContainer = document.getElementById('piano');
function drawKeys() {
  pianoContainer.innerHTML = '';
  notes.forEach((n) => {
    const el = document.createElement('div');
    el.className = `key ${n.b ? 'black' : ''}`;
    el.dataset.midi = n.midi;
    el.dataset.noteVal = (n.midi + (settings.octaveOffset * 12)) % 12;
    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = n.k.toUpperCase();
    el.appendChild(label);
    el.onmouseenter = () => { if (isInteractionActive) { trigger(n.midi); lastTriggeredMidi = n.midi; } };
    el.onmousedown = () => { trigger(n.midi); lastTriggeredMidi = n.midi; };
    pianoContainer.appendChild(el);
  });
}
drawKeys();

window.onkeydown = (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey) return;
  const n = notes.find((x) => x.k === e.key.toLowerCase());
  if (n) trigger(n.midi);
};

// --- Conexão de sala (WebSocket + WebRTC mesh) ---
const roomInput = document.getElementById('room-input');
const connectBtn = document.getElementById('connect-btn');
const userListEl = document.getElementById('user-list');
const statusIndicator = document.getElementById('status-indicator');

function updateUsersUI(remoteUsers = []) {
  userListEl.innerHTML = `<li class="font-bold text-blue-400 flex justify-between"><span>${myEmoji} Você</span></li>`;
  remoteUsers.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'text-gray-400 flex items-center gap-2';
    li.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span> <span>${u.name}</span>`;
    userListEl.appendChild(li);
  });
}

connectBtn.onclick = async () => {
  const roomId = roomInput.value.toUpperCase();
  if (roomId.length < 2) return;
  initAudio();
  connectBtn.disabled = true;
  connectBtn.textContent = '...';
  document.getElementById('user-list-panel').style.display = 'block';

  // BroadcastChannel: continua funcionando para abas do mesmo navegador na mesma sala
  currentBC = new BroadcastChannel(`piano-${roomId}`);
  currentBC.onmessage = (e) => trigger(e.data.m, false, e.data.w, e.data.e);

  try {
    signaling = new SignalingClient();
    mesh = new PeerMesh(signaling);

    mesh.addEventListener('note', (e) => trigger(e.detail.m, false, e.detail.w, e.detail.e));
    signaling.addEventListener('message', (e) => {
      if (e.detail.type === 'user-list') {
        updateUsersUI(e.detail.users.filter((u) => u.id !== signaling.id));
      }
    });

    await signaling.connect(roomId, myName);

    statusIndicator.className = 'w-2.5 h-2.5 rounded-full bg-green-400';
    connectBtn.textContent = 'SALA ' + roomId;
  } catch (err) {
    console.error('Falha ao conectar à sala:', err);
    statusIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    connectBtn.textContent = 'Erro';
    connectBtn.disabled = false;
  }
};
