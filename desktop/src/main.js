const {
  app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, safeStorage, screen, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { askAboutScreen, describeError, PROVIDERS } = require('./ai');
const { AutoAgent } = require('./agent');
const { WinInput } = require('./input-win');
const { understandSpeech, pcmToWav } = require('./voice');

// ---------- constants ----------
const BALL_WIN = 76;                 // collapsed window: just the ball (+ shadow room)
const PANEL_W = 380;
const PANEL_H = 600;
const CAPTURE_MAX_EDGE = 1920;       // screenshot long edge sent to the AI
const SIG_W = 64;                    // tiny thumbnail used for change detection
const SIG_H = 36;
const CHANGE_THRESHOLD = 0.02;       // mean pixel change (0..1) that counts as "screen changed"
const STABLE_THRESHOLD = 0.01;       // screen must settle below this between two ticks before we ask
const HOTKEY = 'CommandOrControl+Shift+Space';
const STOP_HOTKEY = 'CommandOrControl+Shift+X';

const DEFAULTS = {
  provider: 'gemini',  // gemini (free tier) | claude (paid)
  mode: 'help',        // help: watch + suggest | full: Full Auto, operates the computer
  narrative: false,    // speak answers, questions and results out loud
  mic: false,          // listen for voice tasks and commands
  tasks: [],           // { id, text, status: todo|doing|done|failed, note, at }
  keys: { gemini: '', claude: '' },
  auto: true,          // continuously watch the screen
  intervalSec: 4,      // how often to look for changes
  minGapSec: 12,       // minimum seconds between two automatic AI calls
  effort: 'low',       // low | medium | high — higher is smarter but slower
};

// ---------- settings (API keys encrypted with the OS keychain when available) ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const canEncrypt = () => safeStorage.isEncryptionAvailable();
const decrypt = (v) => (v ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '');
const encrypt = (v) => safeStorage.encryptString(v).toString('base64');

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const keys = { gemini: '', claude: '' };
    for (const p of Object.keys(keys)) {
      if (raw.keysEnc?.[p] && canEncrypt()) keys[p] = decrypt(raw.keysEnc[p]);
      else if (raw.keys?.[p]) keys[p] = raw.keys[p];
    }
    // v1.0 stored a single Claude key
    if (!keys.claude && raw.apiKeyEnc && canEncrypt()) keys.claude = decrypt(raw.apiKeyEnc);
    else if (!keys.claude && raw.apiKey) keys.claude = raw.apiKey;
    const out = { ...DEFAULTS, ...raw, keys };
    delete out.keysEnc; delete out.apiKeyEnc; delete out.apiKey;
    if (!PROVIDERS[out.provider]) out.provider = 'gemini';
    return out;
  } catch {
    return { ...DEFAULTS, keys: { ...DEFAULTS.keys } };
  }
}

function saveSettings(s) {
  const out = { ...s };
  delete out.keys;
  if (canEncrypt()) {
    out.keysEnc = Object.fromEntries(Object.entries(s.keys).filter(([, v]) => v).map(([p, v]) => [p, encrypt(v)]));
  } else {
    out.keys = s.keys;
  }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2));
}

let settings;
const envKey = (p) => PROVIDERS[p].env.map((n) => process.env[n]).find(Boolean) || '';
const effectiveKey = () => settings.keys[settings.provider] || envKey(settings.provider);
const mask = (k) => (k ? '••••' + k.slice(-4) : '');
const geminiKey = () => settings.keys.gemini || envKey('gemini');
const openTasks = () => settings.tasks.filter((t) => t.status === 'todo' || t.status === 'doing').map((t) => t.text);

// ---------- state shared with the ball UI ----------
const state = {
  status: 'idle',      // idle | watching | thinking | answer | paused | error | nokey
  expanded: false,
  alignRight: false,
  alignBottom: false,
  answers: [],         // newest first: { text, at, question, model }
  error: null,
  unread: false,
  agent: null,         // while Full Auto runs: { taskId, task, steps: [{icon,text,at}], question }
  voice: 'off',        // off | listening | processing
  heard: null,         // last thing the mic understood
};

let win;
let ballPos;           // top-left of the ball window when collapsed

function publicState() {
  const { keys, ...rest } = settings;
  return {
    ...state,
    settings: { ...rest, keys: { gemini: mask(keys.gemini), claude: mask(keys.claude) } },
    hasKey: Boolean(effectiveKey()),
    providers: PROVIDERS,
    model: PROVIDERS[settings.provider].model,
    hotkey: HOTKEY.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    stopHotkey: STOP_HOTKEY.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    hasVoiceKey: Boolean(geminiKey()),
    canAuto: process.platform === 'win32',
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
      provider: settings.provider,
      apiKey: effectiveKey(),
      imageBase64: image.toJPEG(80).toString('base64'),
      question: question || (force ? 'Look at my screen and tell me the most useful thing right now.' : null),
      previousAnswer: state.answers[0]?.text,
      tasks: openTasks(),
      effort: settings.effort,
    });
    if (result.text) {
      speak(result.text);
      state.answers.unshift({ text: result.text, at: Date.now(), question, model: result.model || PROVIDERS[settings.provider].model });
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
    if (!settings.auto || busy || settings.mode !== 'help' || state.agent) return;
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

// ---------- narrative: speak out loud ----------
function speak(text, { force = false } = {}) {
  if ((settings.narrative || force) && text && win && !win.isDestroyed()) win.webContents.send('speak', String(text));
}

function note(text, question = null) {
  state.answers.unshift({ text, at: Date.now(), question });
  state.answers = state.answers.slice(0, 30);
  state.unread = !state.expanded;
}

// ---------- tasks ----------
function saveTasks() { saveSettings(settings); push(); }

function addTask(text) {
  text = String(text || '').trim();
  if (!text) return null;
  const task = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, status: 'todo', note: '', at: Date.now() };
  settings.tasks.push(task);
  saveTasks();
  if (settings.mode === 'full') setTimeout(() => runNextTask(), 300);
  return task;
}

function setMode(mode) {
  if (!['help', 'full'].includes(mode) || mode === settings.mode) return;
  settings.mode = mode;
  saveSettings(settings);
  if (mode === 'help') {
    stopAgent();
    speak('Help mode. I will watch and suggest.');
    setStatus(settings.auto ? 'watching' : 'paused');
  } else {
    speak('Full auto mode.');
    setStatus('idle');
    runNextTask();
  }
}

// ---------- Full Auto ----------
let input = null;
let agent = null;
let pendingAsk = null;

async function agentCapture() {
  const { image, display } = await captureScreen();
  const db = display.bounds;
  const toDip = (nx, ny) => ({ x: db.x + (nx / 1000) * db.width, y: db.y + (ny / 1000) * db.height });
  return {
    jpeg: image.toJPEG(80).toString('base64'),
    toScreen: (nx, ny) => {
      const p = toDip(nx, ny);
      return process.platform === 'win32' ? screen.dipToScreenPoint(p) : p;
    },
    isOwnWindow: (nx, ny) => {
      const p = toDip(nx, ny);
      const b = win.getBounds();
      return p.x >= b.x - 4 && p.x <= b.x + b.width + 4 && p.y >= b.y - 4 && p.y <= b.y + b.height + 4;
    },
  };
}

function askUser(question) {
  return new Promise((resolve, reject) => {
    pendingAsk = { resolve, reject };
    if (state.agent) state.agent.question = question;
    setExpanded(true);
    speak(question, { force: true });
    setStatus('waiting');
  });
}

function answerAgent(answer) {
  if (!pendingAsk) return false;
  const p = pendingAsk;
  pendingAsk = null;
  if (state.agent) state.agent.question = null;
  setExpanded(false);
  setStatus('working');
  p.resolve(String(answer || '').trim() || 'yes');
  return true;
}

function stopAgent() {
  if (!agent) return;
  agent.stop();
  if (pendingAsk) { pendingAsk.reject(new Error('Stopped by the user.')); pendingAsk = null; }
}

async function runNextTask(taskId = null) {
  if (agent || settings.mode !== 'full') return;
  const task = taskId ? settings.tasks.find((t) => t.id === taskId) : settings.tasks.find((t) => t.status === 'todo');
  if (!task) return;
  if (process.platform !== 'win32') { setStatus('error', { error: 'Full Auto currently works on Windows only. Help mode works everywhere.' }); return; }
  if (!effectiveKey()) { setStatus('nokey'); setExpanded(true); return; }

  input = input || new WinInput();
  task.status = 'doing';
  task.note = '';
  saveTasks();
  state.agent = { taskId: task.id, task: task.text, steps: [], question: null };
  setExpanded(false);
  setStatus('working', { error: null });
  speak(`Starting: ${task.text}`);

  agent = new AutoAgent({
    provider: settings.provider,
    apiKey: effectiveKey(),
    effort: settings.effort === 'low' ? 'medium' : settings.effort, // operating a computer needs a bit more thought
    capture: agentCapture,
    input,
    openUrl: (url) => shell.openExternal(url),
    askUser,
    onStep: (step) => {
      if (!state.agent) return;
      state.agent.steps.push({ ...step, at: Date.now() });
      state.agent.steps = state.agent.steps.slice(-40);
      push();
    },
  });

  let result;
  try {
    result = await agent.run(task.text);
  } catch (err) {
    result = { success: false, summary: describeError(err) };
  }
  const stopped = agent.stopped;
  agent = null;
  pendingAsk = null;
  task.status = result.success ? 'done' : (stopped ? 'todo' : 'failed');
  task.note = result.summary;
  saveTasks();
  state.agent = null;
  note(`${result.success ? '✅' : stopped ? '⏹️' : '⚠️'} ${result.summary}`, task.text);
  speak(result.success ? `Done. ${result.summary}` : result.summary);
  setStatus(result.success ? 'answer' : stopped ? 'idle' : 'error', { error: result.success || stopped ? null : result.summary });
  if (!stopped && settings.mode === 'full') setTimeout(() => runNextTask(), 1500);
}

// ---------- voice ----------
let voiceBusy = false;
async function handleVoiceClip(pcm, sampleRate) {
  if (voiceBusy || !settings.mic) return;
  const key = geminiKey();
  if (!key) {
    setStatus('error', { error: 'Voice uses Google Gemini. Add a free Gemini key in ⚙️ settings (you can still use Claude for the rest).' });
    return;
  }
  voiceBusy = true;
  state.voice = 'processing';
  push();
  try {
    const u8 = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
    const int16 = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + (u8.byteLength & ~1)));
    const r = await understandSpeech({
      apiKey: key,
      wav: pcmToWav(int16, sampleRate),
      mode: settings.mode,
      pendingQuestion: state.agent?.question,
      tasks: openTasks(),
    });
    if (!r || r.intent === 'ignore' || !r.transcript) return;
    state.heard = { text: r.transcript, at: Date.now() };
    switch (r.intent) {
      case 'add_task': {
        const t = addTask(r.task || r.transcript);
        if (t) { note(`📝 Added task: **${t.text}**`); speak(`Added: ${t.text}`); }
        break;
      }
      case 'answer_question':
        if (!answerAgent(r.answer || r.transcript)) note(`🎤 ${r.transcript}`);
        break;
      case 'ask_about_screen':
        ask({ question: r.question || r.transcript, force: true });
        break;
      case 'command':
        runVoiceCommand(r.command);
        break;
      default:
        if (r.reply) { note(r.reply, r.transcript); speak(r.reply); }
    }
  } catch (err) {
    setStatus('error', { error: describeError(err) });
  } finally {
    voiceBusy = false;
    state.voice = settings.mic ? 'listening' : 'off';
    push();
  }
}

function runVoiceCommand(cmd) {
  switch (cmd) {
    case 'help_mode': setMode('help'); break;
    case 'auto_mode': setMode('full'); break;
    case 'start_tasks': if (settings.mode !== 'full') setMode('full'); else runNextTask(); break;
    case 'narrative_on': setNarrative(true); break;
    case 'narrative_off': speak('Okay, I will be quiet.'); setNarrative(false); break;
    case 'stop': stopAgent(); speak('Stopped.', { force: true }); break;
    case 'pause': stopAgent(); setAuto(false); break;
    case 'resume': setAuto(true); break;
    case 'clear_done': settings.tasks = settings.tasks.filter((t) => t.status !== 'done'); saveTasks(); break;
    default: break;
  }
  push();
}

// ---------- IPC ----------
function contextMenu() {
  return Menu.buildFromTemplate([
    ...(agent ? [{ label: '⏹  Stop Full Auto', accelerator: STOP_HOTKEY, click: stopAgent }, { type: 'separator' }] : []),
    { label: settings.mode === 'help' ? '🤖  Switch to Full Auto' : '💡  Switch to Help mode', click: () => setMode(settings.mode === 'help' ? 'full' : 'help') },
    { label: settings.mic ? '🎤  Turn mic off' : '🎤  Turn mic on', click: () => setMic(!settings.mic) },
    { label: settings.narrative ? '🔇  Narrative off' : '🔊  Narrative on', click: () => setNarrative(!settings.narrative) },
    { type: 'separator' },
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

function setMic(on) {
  settings.mic = Boolean(on);
  saveSettings(settings);
  state.voice = settings.mic ? 'listening' : 'off';
  push();
}
function setNarrative(on) {
  settings.narrative = Boolean(on);
  saveSettings(settings);
  push();
  if (on) speak('Narrative on. I will tell you what happens.');
}

ipcMain.handle('get-state', () => publicState());
ipcMain.on('set-mode', (_e, mode) => setMode(mode));
ipcMain.on('set-mic', (_e, on) => setMic(on));
ipcMain.on('set-narrative', (_e, on) => setNarrative(on));
ipcMain.on('voice-clip', (_e, clip) => clip && handleVoiceClip(clip.pcm, clip.sampleRate || 16000));
ipcMain.on('task-add', (_e, text) => addTask(text));
ipcMain.on('task-remove', (_e, id) => { settings.tasks = settings.tasks.filter((t) => t.id !== id || t.status === 'doing'); saveTasks(); });
ipcMain.on('task-toggle', (_e, id) => {
  const t = settings.tasks.find((x) => x.id === id);
  if (t && t.status !== 'doing') { t.status = t.status === 'done' ? 'todo' : 'done'; saveTasks(); }
});
ipcMain.on('task-run', (_e, id) => {
  const t = settings.tasks.find((x) => x.id === id);
  if (!t || t.status === 'doing' || agent) return;
  t.status = 'todo';
  if (settings.mode !== 'full') { settings.mode = 'full'; saveSettings(settings); }
  runNextTask(id);
});
ipcMain.on('agent-stop', stopAgent);
ipcMain.on('agent-answer', (_e, answer) => answerAgent(answer));
ipcMain.on('toggle-panel', () => setExpanded(!state.expanded));
ipcMain.on('collapse', () => setExpanded(false));
ipcMain.on('drag-start', startDrag);
ipcMain.on('drag-end', endDrag);
ipcMain.on('context-menu', () => contextMenu().popup({ window: win }));
ipcMain.on('set-auto', (_e, auto) => setAuto(Boolean(auto)));
ipcMain.on('ask', (_e, question) => {
  if (pendingAsk && question) { answerAgent(question); return; }
  ask({ question: (question || '').trim() || null, force: true });
});
ipcMain.on('clear', () => { state.answers = []; setStatus(settings.auto ? 'watching' : 'idle'); });
ipcMain.on('quit', () => app.quit());
ipcMain.on('save-settings', (_e, incoming) => {
  const next = { ...settings, keys: { ...settings.keys } };
  if (PROVIDERS[incoming.provider]) next.provider = incoming.provider;
  const key = typeof incoming.apiKey === 'string' ? incoming.apiKey.trim() : '';
  if (key && !key.startsWith('••••')) next.keys[next.provider] = key;
  if (incoming.clearKey) next.keys[next.provider] = '';
  if (Number.isFinite(+incoming.intervalSec)) next.intervalSec = Math.min(60, Math.max(2, +incoming.intervalSec));
  if (Number.isFinite(+incoming.minGapSec)) next.minGapSec = Math.min(600, Math.max(3, +incoming.minGapSec));
  if (['low', 'medium', 'high'].includes(incoming.effort)) next.effort = incoming.effort;
  settings = next;
  saveSettings(settings);
  setStatus(effectiveKey() ? (settings.auto ? 'watching' : 'paused') : 'nokey', { error: null });
});

// `npm run selftest`: capture the screen + render the ball, save both, print a report, exit.
async function selfTest() {
  saveSettings = () => {}; // eslint-disable-line no-func-assign
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
    // Full Auto view with sample tasks (in memory only — nothing is saved)
    settings.mode = 'full';
    settings.keys = { ...settings.keys, gemini: 'selftest-dummy' };
    settings.tasks = [
      { id: 'a', text: 'Book a flight from Delhi to Bengaluru', status: 'doing', note: '', at: Date.now() },
      { id: 'b', text: 'Email Ravi the project update', status: 'todo', note: '', at: Date.now() },
      { id: 'c', text: 'Buy milk', status: 'done', note: 'Marked done', at: Date.now() },
    ];
    state.agent = { taskId: 'a', task: 'Book a flight from Delhi to Bengaluru', question: 'Book IndiGo 6E-2134 at 9:00 for ₹4,512? I will stop at the payment page.', steps: [
      { icon: '🌐', text: 'Open Google Flights' }, { icon: '🖱️', text: 'Click the From field' }, { icon: '⌨️', text: 'Type Delhi' }, { icon: '⌨️', text: 'Type Bengaluru' }, { icon: '❓', text: 'Asked which flight' }] };
    state.heard = { text: 'book a flight ticket from Delhi to Bengaluru', at: Date.now() };
    state.status = 'waiting';
    push();
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(path.join(out, 'panel-auto.png'), (await win.webContents.capturePage()).toPNG());
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
    globalShortcut.register(STOP_HOTKEY, () => { stopAgent(); speak('Stopped.', { force: true }); });
    if (!Array.isArray(settings.tasks)) settings.tasks = [];
    settings.tasks.forEach((t) => { if (t.status === 'doing') t.status = 'todo'; });
    state.voice = settings.mic ? 'listening' : 'off';
    if (!effectiveKey()) setStatus('nokey');
    else setStatus(settings.auto ? 'watching' : 'paused');
    loopTimer = setTimeout(tick, 1500);
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopAgent(); if (input) input.stop(); });
  app.on('window-all-closed', () => app.quit());
}
