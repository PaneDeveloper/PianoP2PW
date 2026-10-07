// Controle Remoto - interface.
//  • TV/PC  -> botão "Controle Remoto": mostra QR Code + código, contador "Pessoas na Sala: X"
//              e toca as notas que chegam dos controles (som, rastro e emoji do bichinho).
//  • Celular/tablet -> "Conectar com Código" (ou QR Code): vira um controle com piano + tela cheia.
import qrcode from './vendor/qrcode.js';
import { RemoteLink, normalizeCode } from './remote.js';

const $ = (id) => document.getElementById(id);
const CODE_KEY = 'pianoRemoteCode';

// TV ou PC? (celular/tablet = controle)
export function detectDevice() {
  const ua = navigator.userAgent || '';
  const touch = navigator.maxTouchPoints || 0;
  const tv = /SMART-?TV|HbbTV|NetCast|Web0S|WebOS|BRAVIA|Android TV|GoogleTV|AppleTV|CrKey|Roku|VIDAA|Viera|Opera TV|TV Safari|\bTV\b/i.test(ua) || /\bAFT[A-Z0-9]{1,5}\b/.test(ua); // AFT* = Fire TV
  const apple = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1); // iPadOS se disfarça de Mac
  const androidTouch = /Android/i.test(ua) && touch > 0;                            // Android sem toque = TV/box
  const mobileUA = /Mobile|Tablet|Silk|Kindle/i.test(ua);
  const isMobile = !tv && (apple || androidTouch || mobileUA);
  return { isTV: tv, isMobile, isHostDevice: tv || !isMobile };
}

const formatCode = (c) => (c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c);

function joinUrl(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('remote', code);
  return u.toString();
}

function drawQR(code) {
  const box = $('remote-qr');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(joinUrl(code));
    qr.make();
    const n = qr.getModuleCount();
    const m = 4; // margem (quiet zone) exigida pelos leitores de QR
    const size = n + m * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    }
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  } catch {
    box.textContent = 'QR indisponível — use o código abaixo';
  }
}

const ERRORS = {
  'not-found': 'Código não encontrado. Confere se a sala ainda está aberta na TV/PC.',
  full: 'Essa sala está cheia.',
  'too-many': 'Muitas tentativas erradas. Recarrega a página e tenta de novo.',
  offline: 'Não consegui falar com o servidor. Verifica a internet.',
};

export function initRemoteUI({ unlockAudio, onNote, myEmoji }) {
  const dev = detectDevice();
  let link = null;
  let role = null; // 'host' | 'controller'
  let reconnecting = false;
  let wakeLock = null;

  const btnHost = $('remote-host-btn');
  const btnJoin = $('remote-join-btn');
  const card = $('remote-qr-card');

  // ---------- util ----------
  let toastTimer = null;
  function toast(msg, ms = 3500) {
    const t = $('remote-toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- TV / PC (host) ----------
  if (!dev.isHostDevice) btnHost.style.display = 'none';

  function setBadge(count) {
    $('remote-count').textContent = `Pessoas na Sala: ${count}`;
  }

  function makeHostLink() {
    const l = new RemoteLink();
    l.addEventListener('count', (e) => setBadge(e.detail.count));
    l.addEventListener('note', (e) => onNote(e.detail.m, e.detail.emoji));
    l.addEventListener('status', (e) => $('remote-dot').classList.toggle('warn', e.detail.state === 'reconnecting'));
    l.addEventListener('closed', () => {
      if (link !== l) return;
      teardownHost();
      toast('A conexão do Controle Remoto caiu. Clique em "Controle Remoto" pra abrir de novo.', 5000);
    });
    return l;
  }

  async function startHost() {
    unlockAudio(); // o navegador só libera o som depois de um clique
    btnHost.disabled = true;
    let saved = null;
    try { saved = sessionStorage.getItem(CODE_KEY); } catch { /* sem storage */ }

    let l = makeHostLink();
    try {
      try {
        await l.host(saved);
      } catch (err) {
        if (saved && err.message === 'taken') { l = makeHostLink(); await l.host(null); } else throw err;
      }
    } catch {
      toast('Não consegui abrir o Controle Remoto 😕 Tenta de novo.');
      btnHost.disabled = false;
      return;
    }

    link = l;
    role = 'host';
    try { sessionStorage.setItem(CODE_KEY, l.code); } catch { /* sem storage */ }

    drawQR(l.code);
    $('remote-code').textContent = formatCode(l.code);
    setBadge(l.count);
    $('remote-dot').classList.remove('warn');
    document.body.classList.add('remote-on');
    card.classList.add('open');
    btnHost.classList.add('active');
    btnHost.disabled = false;
    btnJoin.disabled = true;
  }

  function teardownHost(forget = false) {
    role = null;
    link = null;
    card.classList.remove('open');
    btnHost.classList.remove('active');
    btnHost.disabled = false;
    btnJoin.disabled = false;
    document.body.classList.remove('remote-on');
    if (forget) { try { sessionStorage.removeItem(CODE_KEY); } catch { /* ignore */ } }
  }

  btnHost.onclick = async () => {
    if (role === 'host') {
      const open = card.classList.toggle('open');
      btnHost.classList.toggle('active', open);
      return;
    }
    await startHost();
  };

  $('remote-end').onclick = () => {
    if (role !== 'host') return;
    link.end();
    teardownHost(true);
    toast('Sala do Controle Remoto encerrada.');
  };

  // ---------- Celular / tablet (controle) ----------
  const modal = $('remote-join-modal');
  const overlay = $('modal-overlay');
  const input = $('remote-code-input');
  const goBtn = $('remote-join-go');

  function openJoin(prefill = '') {
    if (role === 'host') return;
    if (prefill) input.value = prefill;
    modal.style.display = 'block';
    overlay.style.display = 'block';
    setTimeout(() => input.focus(), 50);
  }
  function closeJoin() {
    modal.style.display = 'none';
    overlay.style.display = 'none';
    input.blur();
  }
  const setJoinMsg = (t) => { $('remote-join-msg').textContent = t || ''; };

  btnJoin.onclick = () => { setJoinMsg(''); openJoin(); };
  $('remote-join-close').onclick = closeJoin;
  input.onkeydown = (e) => { if (e.key === 'Enter') goBtn.click(); e.stopPropagation(); };
  goBtn.onclick = async () => {
    goBtn.disabled = true;
    setJoinMsg('');
    const ok = await startController(input.value);
    goBtn.disabled = false;
    if (ok) closeJoin();
  };

  const fsRoot = document.documentElement;
  const canFullscreen = !!(fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen);
  const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  async function toggleFullscreen() {
    try {
      if (isFullscreen()) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        return;
      }
      await (fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen).call(fsRoot);
      try { await screen.orientation?.lock?.('landscape'); } catch { /* nem todo navegador deixa */ }
    } catch {
      toast('Esse navegador não deixou entrar em tela cheia.');
    }
  }
  function paintFullscreen() {
    $('ctrl-fs').textContent = isFullscreen() ? '⛶ Sair da tela cheia' : '⛶ Tela cheia';
  }
  document.addEventListener('fullscreenchange', paintFullscreen);
  document.addEventListener('webkitfullscreenchange', paintFullscreen);
  if (!canFullscreen) $('ctrl-fs').style.display = 'none';

  async function lockScreen() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* sem wake lock */ }
  }

  function paintStatus() {
    if (role !== 'controller' || !link) return;
    let text;
    let warn = false;
    if (reconnecting) { text = 'Reconectando…'; warn = true; }
    else if (!link.hostOnline) { text = 'Aguardando a TV/PC voltar…'; warn = true; }
    else text = `${link.count} na sala · ${link.direct ? '⚡ direto' : 'via servidor'}`;
    $('ctrl-status-text').textContent = text;
    $('ctrl-dot').classList.toggle('warn', warn);
  }

  async function startController(rawCode) {
    const code = normalizeCode(rawCode);
    if (code.length !== 10) { setJoinMsg('O código tem 10 caracteres.'); return false; }

    const l = new RemoteLink();
    l.addEventListener('count', paintStatus);
    l.addEventListener('host', paintStatus);
    l.addEventListener('status', (e) => { reconnecting = e.detail.state === 'reconnecting'; paintStatus(); });
    l.addEventListener('closed', (e) => {
      if (link !== l) return;
      const why = e.detail.reason === 'ended' ? 'A sala foi encerrada pela TV/PC.' : 'Perdi a conexão com a sala.';
      exitController(why);
    });

    let info;
    try {
      info = await l.join(code, myEmoji);
    } catch (err) {
      setJoinMsg(ERRORS[err.message] || ERRORS.offline);
      return false;
    }

    link = l;
    role = 'controller';
    reconnecting = false;
    enterControllerMode(code, info.emoji);
    return true;
  }

  function enterControllerMode(code, emoji) {
    document.body.classList.add('controller-mode');
    $('ctrl-emoji').textContent = emoji;
    $('ctrl-room').textContent = `SALA ${formatCode(code)}`;
    paintStatus();
    paintFullscreen();

    // guarda o código na URL: se o navegador recarregar a aba, ele volta pra sala sozinho
    try { history.replaceState(null, '', `?remote=${code}`); } catch { /* ignore */ }

    const intro = $('ctrl-intro');
    $('ctrl-intro-fs').style.display = canFullscreen ? '' : 'none';
    $('ctrl-intro-text').textContent = canFullscreen
      ? 'Conectado! Entre em tela cheia pra tocar com o piano ocupando tudo.'
      : 'Conectado! Dica: no iPhone, use Compartilhar → "Adicionar à Tela de Início" pra abrir em tela cheia.';
    $('ctrl-intro-skip').textContent = canFullscreen ? 'Continuar sem tela cheia' : 'Começar a tocar';
    intro.classList.add('show');
    lockScreen();
  }

  function exitController(msg) {
    link?.leave();
    link = null;
    role = null;
    reconnecting = false;
    document.body.classList.remove('controller-mode');
    $('ctrl-intro').classList.remove('show');
    if (isFullscreen()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
    try { wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
    if (msg) toast(msg, 5000);
  }

  $('ctrl-fs').onclick = toggleFullscreen;
  $('ctrl-exit').onclick = () => exitController('Você saiu da sala.');
  $('ctrl-intro-fs').onclick = async () => { $('ctrl-intro').classList.remove('show'); await toggleFullscreen(); };
  $('ctrl-intro-skip').onclick = () => $('ctrl-intro').classList.remove('show');

  document.addEventListener('contextmenu', (e) => { if (role === 'controller') e.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && link) {
      if (role === 'controller') lockScreen();
      link.kick();
    }
  });

  // abriu pelo QR Code (…/?remote=CODIGO): entra direto, sem digitar nada
  const fromUrl = new URLSearchParams(location.search).get('remote');
  if (fromUrl) {
    toast('Conectando ao piano…', 10000);
    startController(fromUrl).then((ok) => {
      if (ok) { $('remote-toast').classList.remove('show'); return; }
      openJoin(formatCode(normalizeCode(fromUrl)));
      try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
    });
  }

  return {
    isController: () => role === 'controller',
    emoji: () => link?.emoji || myEmoji,
    sendNote: (m) => link?.sendNote(m),
  };
}
