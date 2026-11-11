import './style.css';
import { askAboutScreen, describeError, PROVIDERS } from './ai.js';
import { renderMarkdown, escapeHtml, timeAgo } from './markdown.js';

// Cache every element once: after "Pop out" the widget lives in another document,
// where document.getElementById would no longer find it.
const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));
const $ = (id) => els[id];

const EMOJI = { idle: '🙂', watching: '👀', thinking: '🤔', answer: '💡', paused: '😴', error: '⚠️', nokey: '🔑' };
const STATUS_TEXT = {
  idle: 'pick 📺 Screen or 📷 Camera to start watching',
  watching: 'watching', thinking: 'thinking…', answer: 'new answer', paused: 'paused',
  error: 'something went wrong', nokey: 'needs an API key',
};

const SIG_W = 64;
const SIG_H = 36;
const CHANGE_THRESHOLD = 0.02;
const STABLE_THRESHOLD = 0.01;
const CAPTURE_MAX_EDGE = 1920;
const BALL = 64;

// ---------- persisted settings (this browser only) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('freedom.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('freedom.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const settings = {
  provider: store.get('provider', 'gemini'),
  keys: store.get('keys', { gemini: '', claude: store.get('apiKey', '') }), // v1.0 kept one Claude key in 'apiKey'
  auto: store.get('auto', true),
  intervalSec: store.get('intervalSec', 4),
  minGapSec: store.get('minGapSec', 12),
  effort: store.get('effort', 'low'),
};
const saveSettings = () => Object.entries(settings).forEach(([k, v]) => store.set(k, v));
if (!PROVIDERS[settings.provider]) settings.provider = 'gemini';
const currentKey = () => settings.keys[settings.provider] || '';

const state = {
  status: currentKey() ? 'idle' : 'nokey',
  expanded: false,
  answers: [],
  error: null,
  unread: false,
  source: null,          // 'screen' | 'camera' | null
  settingsOpen: false,
  pip: null,             // Document Picture-in-Picture window, when popped out
};

// ---------- capture ----------
const video = $('preview');
let stream = null;
const sigCanvas = document.createElement('canvas');
sigCanvas.width = SIG_W;
sigCanvas.height = SIG_H;
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });

function frameToJpeg(source, w, h) {
  const r = Math.min(1, CAPTURE_MAX_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * r);
  c.height = Math.round(h * r);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8).split(',')[1];
}

function signature() {
  sigCtx.drawImage(video, 0, 0, SIG_W, SIG_H);
  const d = sigCtx.getImageData(0, 0, SIG_W, SIG_H).data;
  const sig = new Float32Array(SIG_W * SIG_H);
  for (let i = 0; i < sig.length; i++) sig[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  return sig;
}

function diff(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

async function startSource(kind) {
  stopSource();
  try {
    if (kind === 'screen') {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 5 }, audio: false, monitorTypeSurfaces: 'include',
      });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
    }
  } catch (err) {
    stream = null;
    if (err?.name !== 'NotAllowedError') setStatus('error', { error: `Could not start ${kind}: ${err?.message || err}` });
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  stream.getVideoTracks()[0].addEventListener('ended', stopSource);
  state.source = kind;
  lastSentSig = null;
  prevTickSig = null;
  if (!currentKey()) setStatus('nokey');
  else setStatus(settings.auto ? 'watching' : 'paused', { error: null });
  scheduleTick(500);
}

function stopSource() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  state.source = null;
  if (['watching', 'paused'].includes(state.status)) setStatus(currentKey() ? 'idle' : 'nokey');
  else render();
}

// ---------- asking Claude ----------
let busy = false;
let lastSentSig = null;
let prevTickSig = null;
let lastCallAt = 0;
let rebaseline = false;
let tickTimer = null;

async function ask({ imageBase64, question = null }) {
  if (busy) return;
  if (!currentKey()) { setStatus('nokey'); expand(true); return; }
  busy = true;
  setStatus('thinking', { error: null });
  lastCallAt = Date.now();
  try {
    const result = await askAboutScreen({
      provider: settings.provider,
      apiKey: currentKey(),
      imageBase64,
      question,
      previousAnswer: state.answers[0]?.text,
      effort: settings.effort,
    });
    if (result.text) {
      state.answers.unshift({ text: result.text, at: Date.now(), question, model: result.model || PROVIDERS[settings.provider].model });
      state.answers = state.answers.slice(0, 20);
      state.unread = !state.expanded;
      rebaseline = true; // showing the answer changes the screen; don't treat that as new content
      setStatus('answer');
    } else {
      setStatus(state.source ? (settings.auto ? 'watching' : 'paused') : 'idle');
    }
  } catch (err) {
    setStatus('error', { error: describeError(err) });
  } finally {
    busy = false;
  }
}

function askFromVideo(question) {
  if (!video.videoWidth) return false;
  lastSentSig = signature();
  prevTickSig = lastSentSig;
  ask({ imageBase64: frameToJpeg(video, video.videoWidth, video.videoHeight), question });
  return true;
}

function scheduleTick(ms) {
  clearTimeout(tickTimer);
  tickTimer = setTimeout(tick, ms ?? Math.max(2, settings.intervalSec) * 1000);
}

function tick() {
  try {
    if (!stream || !settings.auto || busy || !currentKey() || !video.videoWidth) return;
    const sig = signature();
    if (rebaseline) { lastSentSig = sig; prevTickSig = sig; rebaseline = false; return; }
    const changed = diff(sig, lastSentSig) > CHANGE_THRESHOLD;
    const settled = diff(sig, prevTickSig) < STABLE_THRESHOLD;
    prevTickSig = sig;
    if (changed && settled && Date.now() - lastCallAt > settings.minGapSec * 1000) askFromVideo(null);
  } finally {
    if (stream) scheduleTick();
  }
}

function askNow(question) {
  if (stream && askFromVideo(question)) return;
  if (question) { pendingQuestion = question; $('photoInput').click(); return; }
  setStatus('idle', { error: 'Pick 📺 Screen, 📷 Camera, or 🖼️ Photo first so I can see something.' });
}

let pendingQuestion = null;
$('photoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const q = pendingQuestion;
    pendingQuestion = null;
    await ask({ imageBase64: frameToJpeg(bmp, bmp.width, bmp.height), question: q || 'What should I know about this?' });
  } catch (err) {
    setStatus('error', { error: `Could not read that image: ${err?.message || err}` });
  }
});

// ---------- UI ----------
const widget = $('widget');
const ball = $('ball');

function setStatus(status, extra = {}) {
  Object.assign(state, { status }, extra);
  render();
}

let ballPos = store.get('ballPos', null);
function placeBall() {
  if (state.pip) return;
  // clientWidth excludes the page scrollbar, so the ball never hides behind it
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  if (!ballPos) ballPos = { x: vw - BALL - 12, y: Math.round(vh * 0.35) };
  ballPos.x = Math.min(Math.max(ballPos.x, 4), vw - BALL - 4);
  ballPos.y = Math.min(Math.max(ballPos.y, 4), vh - BALL - 4);
  ball.style.left = ballPos.x + 'px';
  ball.style.top = ballPos.y + 'px';

  const panel = $('panel');
  if (vw < 560) { panel.style.cssText = ''; widget.classList.add('sheet'); return; }
  widget.classList.remove('sheet');
  const pw = 380;
  const ph = Math.min(560, vh - 24);
  const right = ballPos.x + BALL / 2 > vw / 2;
  const left = right ? ballPos.x - pw - 10 : ballPos.x + BALL + 10;
  const top = Math.min(Math.max(ballPos.y - 20, 12), vh - ph - 12);
  panel.style.cssText = `left:${Math.max(12, left)}px;top:${top}px;width:${pw}px;height:${ph}px`;
}

function expand(open) {
  state.expanded = open;
  if (open) {
    state.unread = false;
    fillSettings();
  }
  render();
}

function fillProvider(provider) {
  const info = PROVIDERS[provider];
  $('provider').value = provider;
  $('keyLabel').textContent = provider === 'gemini' ? 'Gemini API key (free)' : 'Anthropic API key';
  $('apiKey').placeholder = info.keyHint;
  $('apiKey').value = settings.keys[provider] || '';
  $('keyLink').href = info.keyUrl;
  $('keyLink').textContent = provider === 'gemini' ? 'Get a free key at aistudio.google.com' : 'Get a key at console.anthropic.com';
  $('freeNote').hidden = provider !== 'gemini';
}

function fillSettings() {
  fillProvider(settings.provider);
  $('intervalSec').value = settings.intervalSec;
  $('minGapSec').value = settings.minGapSec;
  $('effort').value = settings.effort;
}

function render() {
  const s = state;
  ball.className = `ball ${s.status}`;
  $('emoji').textContent = EMOJI[s.status] || '🙂';
  $('dot').hidden = !s.unread || s.expanded;
  const open = s.expanded || Boolean(s.pip);
  $('panel').hidden = !open;
  widget.classList.toggle('open', open);
  placeBall();
  if (!open) return;

  const src = s.source === 'screen' ? ' · screen' : s.source === 'camera' ? ' · camera' : '';
  $('statusText').textContent = (EMOJI[s.status] || '') + ' ' + (STATUS_TEXT[s.status] || s.status) + (s.status === 'watching' ? src : '');
  $('autoBtn').textContent = settings.auto ? '⏸' : '▶';
  $('autoBtn').title = settings.auto ? 'Pause watching' : 'Resume watching';
  $('closeBtn').hidden = Boolean(s.pip);
  $('error').hidden = !s.error;
  $('error').textContent = s.error || '';
  $('settings').hidden = !(s.settingsOpen || !currentKey());
  $('model').textContent = PROVIDERS[settings.provider].model;

  $('screenBtn').classList.toggle('on', s.source === 'screen');
  $('cameraBtn').classList.toggle('on', s.source === 'camera');
  $('screenBtn').hidden = !navigator.mediaDevices?.getDisplayMedia;
  $('cameraBtn').hidden = !navigator.mediaDevices?.getUserMedia;
  $('pipBtn').hidden = !('documentPictureInPicture' in window) || Boolean(s.pip);
  $('preview').hidden = s.source !== 'camera';

  const box = $('answers');
  if (!s.answers.length) {
    let msg;
    if (!currentKey()) msg = `<span class="big">🔑</span>${settings.provider === 'gemini' ? 'Paste a free Gemini API key above to start.' : 'Paste your Anthropic API key above to start.'}`;
    else if (!s.source) msg = '<span class="big">🙂</span>Pick <strong>📺 Screen</strong> to watch your whole screen, <strong>📷 Camera</strong> to watch through your phone, or <strong>🖼️ Photo</strong> for a single picture.';
    else if (s.status === 'error') msg = '<span class="big">⚠️</span>Fix the problem above, then I will keep watching.';
    else msg = `<span class="big">${EMOJI[s.status]}</span>${settings.auto ? 'Watching. When something needs an answer, it shows up here.' : 'Paused. Ask a question below, or press ▶ to keep watching.'}`;
    box.innerHTML = `<div class="empty">${msg}</div>`;
  } else {
    box.innerHTML = s.answers.map((a, i) => `
      <article class="answer">
        <div class="meta">
          <span title="${escapeHtml(a.model || '')}">${a.question ? '❓ ' + escapeHtml(a.question) : '👀 from your screen'} · ${timeAgo(a.at)}</span>
          <button class="copy" data-i="${i}">Copy</button>
        </div>
        <div class="body">${renderMarkdown(a.text)}</div>
      </article>`).join('');
  }
}

// Ball: tap to open, drag to move (snaps to the nearest side like an assistive-touch button).
let down = null;
let dragging = false;
ball.addEventListener('pointerdown', (e) => {
  if (state.pip) return;
  down = { x: e.clientX, y: e.clientY, bx: ballPos.x, by: ballPos.y };
  dragging = false;
  ball.setPointerCapture(e.pointerId);
});
ball.addEventListener('pointermove', (e) => {
  if (!down) return;
  const dx = e.clientX - down.x;
  const dy = e.clientY - down.y;
  if (!dragging && Math.hypot(dx, dy) > 6) { dragging = true; ball.classList.add('dragging'); }
  if (dragging) {
    ballPos = { x: down.bx + dx, y: down.by + dy };
    ball.style.left = ballPos.x + 'px';
    ball.style.top = ballPos.y + 'px';
  }
});
ball.addEventListener('pointerup', () => {
  if (!down) return;
  if (dragging) {
    ball.classList.remove('dragging');
    const vw = document.documentElement.clientWidth;
    ballPos.x = ballPos.x + BALL / 2 > vw / 2 ? vw - BALL - 12 : 12;
    store.set('ballPos', ballPos);
    render();
  } else {
    expand(!state.expanded);
  }
  down = null;
  dragging = false;
});
window.addEventListener('resize', () => render());

$('closeBtn').onclick = () => expand(false);
$('autoBtn').onclick = () => {
  settings.auto = !settings.auto;
  saveSettings();
  if (state.source) setStatus(settings.auto ? 'watching' : 'paused');
  else render();
  if (settings.auto && stream) { prevTickSig = null; scheduleTick(300); }
};
$('settingsBtn').onclick = () => { state.settingsOpen = !state.settingsOpen; fillSettings(); render(); };
$('saveBtn').onclick = () => {
  settings.provider = $('provider').value;
  settings.keys = { ...settings.keys, [settings.provider]: $('apiKey').value.trim() };
  settings.intervalSec = Math.min(60, Math.max(2, +$('intervalSec').value || 4));
  settings.minGapSec = Math.min(600, Math.max(3, +$('minGapSec').value || 12));
  settings.effort = $('effort').value;
  saveSettings();
  state.settingsOpen = false;
  const status = !currentKey() ? 'nokey' : state.source ? (settings.auto ? 'watching' : 'paused') : 'idle';
  setStatus(status, { error: null });
};
$('clearKeyBtn').onclick = () => {
  settings.provider = $('provider').value;
  settings.keys = { ...settings.keys, [settings.provider]: '' };
  saveSettings();
  $('apiKey').value = '';
  setStatus('nokey');
};
$('provider').onchange = () => fillProvider($('provider').value);
$('screenBtn').onclick = () => (state.source === 'screen' ? stopSource() : startSource('screen'));
$('cameraBtn').onclick = () => (state.source === 'camera' ? stopSource() : startSource('camera'));
$('photoBtn').onclick = () => $('photoInput').click();
$('pipBtn').onclick = popOut;
$('askForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('question').value.trim();
  $('question').value = '';
  askNow(q || null);
};
$('answers').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  navigator.clipboard?.writeText(state.answers[+btn.dataset.i].text);
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
});

// ---------- Pop out: float the panel above every app (Document Picture-in-Picture, Chrome/Edge desktop) ----------
async function popOut() {
  try {
    const pip = await window.documentPictureInPicture.requestWindow({ width: 380, height: 540 });
    for (const sheet of document.styleSheets) {
      try {
        const style = pip.document.createElement('style');
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        pip.document.head.append(style);
      } catch {
        if (sheet.href) {
          const link = pip.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pip.document.head.append(link);
        }
      }
    }
    pip.document.title = 'F.R.E.E.D.O.M';
    state.pip = pip;
    $('panel').style.cssText = '';
    widget.classList.add('in-pip');
    pip.document.body.append(widget);
    pip.addEventListener('pagehide', () => {
      widget.classList.remove('in-pip');
      document.body.append(widget);
      state.pip = null;
      render();
    });
    render();
  } catch (err) {
    setStatus(state.status, { error: `Pop out failed: ${err?.message || err}` });
  }
}

// ---------- boot ----------
render();
setInterval(() => { if (state.expanded || state.pip) render(); }, 30000);
