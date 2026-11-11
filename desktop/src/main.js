const {
  app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, safeStorage, screen, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { askAboutScreen, describeError, MODEL } = require('./claude');

// ---------- constants ----------
const BALL_WIN = 76;                 // collapsed window: just the ball (+ shadow room)
const PANEL_W = 380;
const PANEL_H = 520;
const CAPTURE_MAX_EDGE = 1920;       // screenshot long edge sent to Claude
const SIG_W = 64;                    // tiny thumbnail used for change detection
const SIG_H = 36;
const CHANGE_THRESHOLD = 0.02;       // mean pixel change (0..1) that counts as "screen changed"
const STABLE_THRESHOLD = 0.01;       // screen must settle below this between two ticks before we ask
const HOTKEY = 'CommandOrControl+Shift+Space';

const DEFAULTS = {
  apiKey: '',
  auto: true,          // continuously watch the screen
  intervalSec: 4,      // how often to look for changes
  minGapSec: 12,       // minimum seconds between two automatic Claude calls
  effort: 'low',       // low | medium | high — higher is smarter but slower
};

// ---------- settings (API key encrypted with the OS keychain when available) ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    let apiKey = '';
    if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
    } else if (raw.apiKey) {
      apiKey = raw.apiKey;
    }
    return { ...DEFAULTS, ...raw, apiKey, apiKeyEnc: undefined };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  const out = { ...s };
  delete out.apiKey;
  if (s.apiKey) {
    if (safeStorage.isEncryptionAvailable()) out.apiKeyEnc = safeStorage.encryptString(s.apiKey).toString('base64');
    else out.apiKey = s.apiKey;
  }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2));
}

let settings;
const effectiveKey = () => settings.apiKey || process.env.ANTHROPIC_API_KEY || '';

// ---------- state shared with the ball UI ----------
const state = {
  status: 'idle',      // idle | watching | thinking | answer | paused | error | nokey
  expanded: false,
  alignRight: false,
  alignBottom: false,
  answers: [],         // newest first: { text, at, question }
  error: null,
  unread: false,
};

let win;
let ballPos;           // top-left of the ball window when collapsed

function publicState() {
  return {
    ...state,
    settings: { ...settings, apiKey: settings.apiKey ? '••••' + settings.apiKey.slice(-4) : '' },
    hasKey: Boolean(effectiveKey()),
    model: MODEL,
    hotkey: HOTKEY.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
  };
}

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
}

function setStatus(status, extra = {}) {
  Object.assign(state, { status }, extra);
  push();
}

// ---------- window ----------
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  ballPos = { x: wa.x + wa.width - BALL_WIN - 24, y: wa.y + Math.round(wa.height * 0.35) };

  win = new BrowserWindow({
    x: ballPos.x, y: ballPos.y, width: BALL_WIN, height: BALL_WIN,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.showInactive(); push(); });

  // Links in answers open in the real browser, never inside the ball.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function clampToWorkArea(b) {
  const wa = screen.getDisplayMatching(b).workArea;
  return {
    ...b,
    x: Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width),
    y: Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height),
  };
}

function setExpanded(expanded) {
  if (expanded === state.expanded) return;
  if (expanded) {
    const [x, y] = win.getPosition();
    ballPos = { x, y };
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    state.alignRight = x + BALL_WIN / 2 > wa.x + wa.width / 2;
    state.alignBottom = y + BALL_WIN / 2 > wa.y + wa.height / 2;
    const bounds = clampToWorkArea({
      x: state.alignRight ? x + BALL_WIN - PANEL_W : x,
      y: state.alignBottom ? y + BALL_WIN - PANEL_H : y,
      width: PANEL_W, height: PANEL_H,
    });
    state.expanded = true;
    state.unread = false;
    push();
    win.setBounds(bounds);
    win.focus();
  } else {
    state.expanded = false;
    push();
    win.setBounds({ ...ballPos, width: BALL_WIN, height: BALL_WIN });
  }
}

// Dragging: the renderer says "start"/"end"; we follow the real cursor in between.
let dragTimer = null;
function startDrag() {
  if (state.expanded) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  const off = { x: cursor.x - wx, y: cursor.y - wy };
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    const c = screen.getCursorScreenPoint();
    win.setPosition(Math.round(c.x - off.x), Math.round(c.y - off.y));
  }, 12);
}
function endDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
  const [x, y] = win.getPosition();
  const b = clampToWorkArea({ x, y, width: BALL_WIN, height: BALL_WIN });
  win.setPosition(b.x, b.y);
  ballPos = { x: b.x, y: b.y };
}

// ---------- screen capture ----------
function currentDisplay() {
  const b = win.getBounds();
  return screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
}

async function captureScreen() {
  const display = currentDisplay();
  const w = display.size.width * display.scaleFactor;
  const h = display.size.height * display.scaleFactor;
  const ratio = Math.min(1, CAPTURE_MAX_EDGE / Math.max(w, h));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(w * ratio), height: Math.round(h * ratio) },
  });
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Screen capture returned nothing. On macOS, allow Screen Recording for this app in System Settings → Privacy & Security.');
  return { image: src.thumbnail, display };
}

// Tiny grayscale fingerprint of the screen, with our own window blanked out so
// the ball/panel changing never counts as "the screen changed".
function signature(image, display) {
  const bmp = image.resize({ width: SIG_W, height: SIG_H, quality: 'good' }).toBitmap(); // BGRA
  const sig = new Float32Array(SIG_W * SIG_H);
  const wb = win.getBounds();
  const db = display.bounds;
  const mx0 = Math.floor(((wb.x - db.x) / db.width) * SIG_W) - 1;
  const my0 = Math.floor(((wb.y - db.y) / db.height) * SIG_H) - 1;
  const mx1 = Math.ceil(((wb.x + wb.width - db.x) / db.width) * SIG_W) + 1;
  const my1 = Math.ceil(((wb.y + wb.height - db.y) / db.height) * SIG_H) + 1;
  for (let y = 0; y < SIG_H; y++) {
    for (let x = 0; x < SIG_W; x++) {
      const i = y * SIG_W + x;
      if (x >= mx0 && x < mx1 && y >= my0 && y < my1) { sig[i] = 0; continue; }
      const p = i * 4;
      sig[i] = (0.114 * bmp[p] + 0.587 * bmp[p + 1] + 0.299 * bmp[p + 2]) / 255;
    }
  }
  return sig;
}

function diff(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// ---------- the watch loop ----------
let busy = false;
let lastSentSig = null;
let prevTickSig = null;
let lastCallAt = 0;
let loopTimer = null;

async function ask({ question = null, force = false } = {}) {
  if (busy) return;
  if (!effectiveKey()) { setStatus('nokey'); return; }
  busy = true;
  setStatus('thinking', { error: null });
  try {
    const { image, display } = await captureScreen();
    lastSentSig = signature(image, display);
    prevTickSig = lastSentSig;
    lastCallAt = Date.now();
    const result = await askAboutScreen({
      apiKey: effectiveKey(),
      imageBase64: image.toJPEG(80).toString('base64'),
      question: question || (force ? 'Look at my screen and tell me the most useful thing right now.' : null),
      previousAnswer: state.answers[0]?.text,
      effort: settings.effort,
    });
    if (result.text) {
      state.answers.unshift({ text: result.text, at: Date.now(), question });
      state.answers = state.answers.slice(0, 20);
      state.unread = !state.expanded;
      setStatus('answer');
    } else {
      setStatus(settings.auto ? 'watching' : 'idle');
    }
  } catch (err) {
    setStatus('error', { error: describeError(err) });
  } finally {
    busy = false;
  }
}

async function tick() {
  try {
    if (!settings.auto || busy) return;
    if (!effectiveKey()) { if (state.status !== 'nokey') setStatus('nokey'); return; }
    if (state.status === 'paused' || state.status === 'nokey' || state.status === 'idle') setStatus('watching');

    const { image, display } = await captureScreen();
    const sig = signature(image, display);
    const changed = diff(sig, lastSentSig) > CHANGE_THRESHOLD;
    const settled = diff(sig, prevTickSig) < STABLE_THRESHOLD;
    prevTickSig = sig;
    const gapOk = Date.now() - lastCallAt > settings.minGapSec * 1000;
    if (changed && settled && gapOk) await ask();
  } catch (err) {
    setStatus('error', { error: describeError(err) });
  } finally {
    clearTimeout(loopTimer);
    loopTimer = setTimeout(tick, Math.max(1, settings.intervalSec) * 1000);
  }
}

// ---------- IPC ----------
function contextMenu() {
  return Menu.buildFromTemplate([
    { label: settings.auto ? '⏸  Pause watching' : '▶  Resume watching', click: () => setAuto(!settings.auto) },
    { label: '💡  Ask about screen now', accelerator: HOTKEY, click: () => ask({ force: true }) },
    { label: '⚙️  Open panel', click: () => setExpanded(true) },
    { type: 'separator' },
    { label: 'Quit F.R.E.E.D.O.M', click: () => app.quit() },
  ]);
}

function setAuto(auto) {
  settings.auto = auto;
  saveSettings(settings);
  setStatus(auto ? 'watching' : 'paused');
  if (auto) { prevTickSig = null; tick(); }
}

ipcMain.handle('get-state', () => publicState());
ipcMain.on('toggle-panel', () => setExpanded(!state.expanded));
ipcMain.on('collapse', () => setExpanded(false));
ipcMain.on('drag-start', startDrag);
ipcMain.on('drag-end', endDrag);
ipcMain.on('context-menu', () => contextMenu().popup({ window: win }));
ipcMain.on('set-auto', (_e, auto) => setAuto(Boolean(auto)));
ipcMain.on('ask', (_e, question) => ask({ question: (question || '').trim() || null, force: true }));
ipcMain.on('clear', () => { state.answers = []; setStatus(settings.auto ? 'watching' : 'idle'); });
ipcMain.on('quit', () => app.quit());
ipcMain.on('save-settings', (_e, incoming) => {
  const next = { ...settings };
  if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim() && !incoming.apiKey.startsWith('••••')) next.apiKey = incoming.apiKey.trim();
  if (incoming.clearKey) next.apiKey = '';
  if (Number.isFinite(+incoming.intervalSec)) next.intervalSec = Math.min(60, Math.max(2, +incoming.intervalSec));
  if (Number.isFinite(+incoming.minGapSec)) next.minGapSec = Math.min(600, Math.max(3, +incoming.minGapSec));
  if (['low', 'medium', 'high'].includes(incoming.effort)) next.effort = incoming.effort;
  settings = next;
  saveSettings(settings);
  setStatus(effectiveKey() ? (settings.auto ? 'watching' : 'paused') : 'nokey', { error: null });
});

// `npm run selftest`: capture the screen + render the ball, save both, print a report, exit.
async function selfTest() {
  const out = path.join(app.getPath('temp'), 'freedom-selftest');
  fs.mkdirSync(out, { recursive: true });
  try {
    await new Promise((r) => win.once('ready-to-show', r));
    await new Promise((r) => setTimeout(r, 800));
    const { image, display } = await captureScreen();
    const sig = signature(image, display);
    fs.writeFileSync(path.join(out, 'screen.jpg'), image.toJPEG(80));
    fs.writeFileSync(path.join(out, 'ball.png'), (await win.webContents.capturePage()).toPNG());
    setExpanded(true);
    state.answers = [{ text: '**Answer: 42.** It is the product of `6 × 7`.\n- works offline\n- works online', at: Date.now() }];
    push();
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(path.join(out, 'panel.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, out, screen: image.getSize(), sigMean: sig.reduce((a, b) => a + b, 0) / sig.length, selfDiff: diff(sig, sig) }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err && err.stack || err) }));
  }
  app.quit();
}

// ---------- app lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && setExpanded(true));
  app.whenReady().then(() => {
    settings = loadSettings();
    createWindow();
    if (process.argv.includes('--selftest')) return selfTest();
    globalShortcut.register(HOTKEY, () => ask({ force: true }));
    if (!effectiveKey()) setStatus('nokey');
    else setStatus(settings.auto ? 'watching' : 'paused');
    loopTimer = setTimeout(tick, 1500);
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
