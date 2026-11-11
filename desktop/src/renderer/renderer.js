/* global freedom */
const $ = (id) => document.getElementById(id);

const EMOJI = {
  idle: '🙂', watching: '👀', thinking: '🤔', answer: '💡', paused: '😴', error: '⚠️', nokey: '🔑',
  working: '🤖', waiting: '❓',
};
const STATUS_TEXT = {
  idle: 'ready', watching: 'watching your screen', thinking: 'thinking…', answer: 'new answer',
  paused: 'paused', error: 'something went wrong', nokey: 'needs an API key',
  working: 'doing your task…', waiting: 'waiting for your answer',
};
const TASK_ICON = { todo: '⬜', doing: '⏳', done: '✅', failed: '⚠️' };

let state = null;
let settingsOpen = false;

// ---------- tiny, safe Markdown (escape first, then a few inline rules) ----------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}
function renderMarkdown(text) {
  const lines = escapeHtml(text).split(/\r?\n/);
  let html = '';
  let list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) { closeList(); html += `<${tag}>`; list = tag; }
      html += `<li>${inline((ul || ol)[1])}</li>`;
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line.replace(/^#+\s*/, ''))}</p>`;
    }
  }
  closeList();
  return html;
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------- render ----------
function render() {
  if (!state) return;
  const root = $('root');
  root.classList.toggle('expanded', state.expanded);
  root.classList.toggle('align-right', state.alignRight);
  root.classList.toggle('align-bottom', state.alignBottom);

  const ball = $('ball');
  ball.className = `ball ${state.status}`;
  const listeningNow = hearing || state.voice === 'processing';
  $('emoji').textContent = listeningNow ? '👂' : EMOJI[state.status] || '🙂';
  $('dot').hidden = !state.unread || state.expanded;
  $('micOn').hidden = !state.settings.mic;
  syncMic();

  $('panel').hidden = !state.expanded;
  if (!state.expanded) return;

  const s = state.settings;
  $('helpBtn').classList.toggle('on', s.mode === 'help');
  $('fullBtn').classList.toggle('on', s.mode === 'full');
  $('fullBtn').disabled = !state.canAuto;
  $('narrBtn').classList.toggle('on', s.narrative);
  $('narrBtn').title = s.narrative ? 'Narrative on: speaks answers and results. Click to mute.' : 'Narrative off. Click to hear answers and results out loud.';
  $('micBtn').classList.toggle('on', s.mic);
  $('micBtn').classList.toggle('live', s.mic && listeningNow);
  $('micBtn').title = s.mic ? 'Mic on: say a task or a command. Click to turn off.' : 'Mic off. Click to talk to F.R.E.E.D.O.M.';
  const heard = micError || (state.voice === 'processing' ? '🎤 understanding…' : hearing ? '🎤 listening…' : state.heard ? `🎤 “${state.heard.text}”` : '');
  $('heard').hidden = !(s.mic || micError) || !heard;
  $('heard').textContent = heard;

  const ag = state.agent;
  $('agent').hidden = !ag;
  if (ag) {
    $('agentTask').textContent = ag.task;
    $('agentQuestion').hidden = !ag.question;
    $('agentQuestionText').textContent = ag.question || '';
    $('agentSteps').innerHTML = ag.steps.slice().reverse().map((st) => `<li>${st.icon} ${escapeHtml(st.text)}</li>`).join('') || '<li>Looking at the screen…</li>';
    $('stopHotkey').textContent = state.stopHotkey;
  }

  const tasks = s.tasks || [];
  $('taskHint').textContent = s.mode === 'full' ? 'Full Auto does these one by one' : 'Help mode guides you on these';
  $('taskList').innerHTML = tasks.length
    ? tasks.map((t) => `
      <li class="task ${t.status}" data-id="${t.id}">
        <button class="check" data-act="toggle" title="${t.status === 'done' ? 'Mark not done' : 'Mark done'}">${TASK_ICON[t.status] || '⬜'}</button>
        <div class="text"><span>${escapeHtml(t.text)}</span>${t.note ? `<small>${escapeHtml(t.note)}</small>` : ''}</div>
        ${t.status !== 'doing' && t.status !== 'done' && state.canAuto ? '<button data-act="run" title="Do it automatically (Full Auto)">▶ Do it</button>' : ''}
        ${t.status !== 'doing' ? '<button data-act="remove" title="Remove">✕</button>' : ''}
      </li>`).join('')
    : `<p class="empty-tasks">No tasks yet. ${s.mic ? 'Say one, e.g. “book a flight from Delhi to Bengaluru”,' : 'Turn on 🎤 and say one, or type it below and press ➕,'} e.g. “book a flight from Delhi to Bengaluru”.</p>`;

  $('statusText').textContent = (s.mode === 'full' ? 'Full Auto · ' : 'Help · ') + (STATUS_TEXT[state.status] || state.status);
  $('autoBtn').textContent = state.settings.auto ? '⏸' : '▶';
  $('autoBtn').title = state.settings.auto ? 'Pause watching' : 'Resume watching';

  $('error').hidden = !state.error;
  $('error').textContent = state.error || '';

  $('settings').hidden = !(settingsOpen || !state.hasKey);
  $('model').textContent = state.model;
  $('hotkey').textContent = state.hotkey;

  const box = $('answers');
  if (!state.answers.length) {
    box.innerHTML = state.hasKey
      ? `<div class="empty"><span class="big">${EMOJI[state.status] || '👀'}</span>
           ${s.mode === 'full' ? 'Full Auto: add a task and I will do it on this computer. I always ask before paying, signing in or sending anything.' : s.auto ? 'Watching your screen. Suggestions and fixes show up here.' : 'Paused. Ask a question below, or press ▶ to keep watching.'}
           <br><br>Ask now: <kbd>${escapeHtml(state.hotkey)}</kbd></div>`
      : `<div class="empty"><span class="big">🔑</span>${state.settings.provider === 'gemini' ? 'Paste a free Gemini API key above to start.' : 'Paste your Anthropic API key above to start.'}</div>`;
  } else {
    box.innerHTML = state.answers.map((a, i) => `
      <article class="answer">
        <div class="meta">
          <span title="${escapeHtml(a.model || '')}">${a.question ? '❓ ' + escapeHtml(a.question) : '👀 from your screen'} · ${timeAgo(a.at)}</span>
          <button class="copy" data-i="${i}">Copy</button>
        </div>
        <div class="body">${renderMarkdown(a.text)}</div>
      </article>`).join('');
  }
}

function fillProvider(provider) {
  const info = state.providers[provider];
  $('provider').value = provider;
  $('keyLabel').textContent = provider === 'gemini' ? 'Gemini API key (free)' : 'Anthropic API key';
  $('apiKey').placeholder = info.keyHint;
  $('apiKey').value = state.settings.keys[provider] || '';
  $('keyLink').href = info.keyUrl;
  $('keyLink').textContent = provider === 'gemini' ? 'Get a free key at aistudio.google.com' : 'Get a key at console.anthropic.com';
  $('freeNote').hidden = provider !== 'gemini';
}

function fillSettings() {
  if (!state) return;
  fillProvider(state.settings.provider);
  $('intervalSec').value = state.settings.intervalSec;
  $('minGapSec').value = state.settings.minGapSec;
  $('effort').value = state.settings.effort;
}

// ---------- ball: click to open, drag to move, right-click for menu ----------
const ball = $('ball');
let down = null;
let dragging = false;
ball.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  dragging = false;
  ball.setPointerCapture(e.pointerId);
});
ball.addEventListener('pointermove', (e) => {
  if (!down || dragging || state?.expanded) return;
  if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
    dragging = true;
    freedom.dragStart();
  }
});
ball.addEventListener('pointerup', () => {
  if (!down) return;
  if (dragging) freedom.dragEnd();
  else freedom.togglePanel();
  down = null;
  dragging = false;
});
ball.addEventListener('contextmenu', (e) => { e.preventDefault(); freedom.contextMenu(); });

// ---------- panel ----------
$('closeBtn').onclick = () => freedom.collapse();
$('autoBtn').onclick = () => freedom.setAuto(!state.settings.auto);
$('settingsBtn').onclick = () => { settingsOpen = !settingsOpen; fillSettings(); render(); };
$('saveBtn').onclick = () => {
  freedom.saveSettings({
    provider: $('provider').value,
    apiKey: $('apiKey').value,
    intervalSec: $('intervalSec').value,
    minGapSec: $('minGapSec').value,
    effort: $('effort').value,
  });
  settingsOpen = false;
};
$('clearKeyBtn').onclick = () => { freedom.saveSettings({ provider: $('provider').value, clearKey: true }); $('apiKey').value = ''; };
$('provider').onchange = () => fillProvider($('provider').value);
$('quitBtn').onclick = () => freedom.quit();
$('askForm').onsubmit = (e) => {
  e.preventDefault();
  freedom.ask($('question').value);
  $('question').value = '';
};
$('helpBtn').onclick = () => freedom.setMode('help');
$('fullBtn').onclick = () => freedom.setMode('full');
$('narrBtn').onclick = () => freedom.setNarrative(!state.settings.narrative);
$('micBtn').onclick = () => { micError = null; freedom.setMic(!state.settings.mic); };
$('stopBtn').onclick = () => freedom.stopAgent();
$('yesBtn').onclick = () => freedom.answerAgent('yes');
$('noBtn').onclick = () => freedom.answerAgent('no');
$('doneBtn').onclick = () => freedom.answerAgent('done — I did it myself, continue');
$('addTaskBtn').onclick = () => {
  const text = $('question').value.trim();
  if (!text) { $('question').focus(); return; }
  freedom.addTask(text);
  $('question').value = '';
};
$('taskList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  const li = e.target.closest('.task');
  if (!btn || !li) return;
  const id = li.dataset.id;
  if (btn.dataset.act === 'toggle') freedom.toggleTask(id);
  if (btn.dataset.act === 'run') freedom.runTask(id);
  if (btn.dataset.act === 'remove') freedom.removeTask(id);
});
$('answers').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  navigator.clipboard.writeText(state.answers[+btn.dataset.i].text);
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') freedom.collapse(); });

// ---------- narrative: text to speech (uses the voices built into the OS, works offline) ----------
let muteMicUntil = 0;
function plainText(t) {
  return String(t).replace(/[*_`#>]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\s+/g, ' ').trim();
}
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => /en[-_]IN/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
}
freedom.onSpeak((text) => {
  const u = new SpeechSynthesisUtterance(plainText(text).slice(0, 600));
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.05;
  u.onend = () => { muteMicUntil = Date.now() + 500; };
  speechSynthesis.speak(u);
});

// ---------- mic: listens continuously, cuts out each spoken phrase, sends it to be understood ----------
const SAMPLE_RATE = 16000;
const mic = { stream: null, ctx: null, node: null, src: null, chunks: [], pre: [], active: false, speechMs: 0, silenceMs: 0, floor: 0.01, thr: 0.02 };
let hearing = false;
let micError = null;

function syncMic() {
  if (state?.settings.mic && !mic.stream && !mic.starting) startMic();
  if (!state?.settings.mic && mic.stream) stopMic();
}

async function startMic() {
  mic.starting = true;
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    mic.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    mic.src = mic.ctx.createMediaStreamSource(mic.stream);
    mic.node = mic.ctx.createScriptProcessor(2048, 1, 1);
    mic.node.onaudioprocess = (e) => onAudio(e.inputBuffer.getChannelData(0));
    mic.src.connect(mic.node);
    mic.node.connect(mic.ctx.destination);
    micError = null;
  } catch (err) {
    micError = `🎤 Microphone unavailable: ${err.message || err}. Check Windows Settings → Privacy → Microphone.`;
    stopMic();
    freedom.setMic(false);
  } finally {
    mic.starting = false;
    render();
  }
}

function stopMic() {
  try { mic.node?.disconnect(); mic.src?.disconnect(); mic.ctx?.close(); } catch { /* already closed */ }
  mic.stream?.getTracks().forEach((t) => t.stop());
  Object.assign(mic, { stream: null, ctx: null, node: null, src: null, chunks: [], pre: [], active: false });
  setHearing(false);
}

function setHearing(on) {
  if (hearing === on) return;
  hearing = on;
  render();
}

function onAudio(frame) {
  const ms = (frame.length / SAMPLE_RATE) * 1000;
  // Don't listen to ourselves talking.
  if (speechSynthesis.speaking || Date.now() < muteMicUntil) {
    if (mic.active) { mic.active = false; mic.chunks = []; setHearing(false); }
    return;
  }
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  const copy = new Float32Array(frame);

  if (!mic.active) {
    mic.floor = mic.floor * 0.95 + Math.min(rms, 0.05) * 0.05;
    mic.pre.push(copy);
    if (mic.pre.length > 3) mic.pre.shift();
    const thr = Math.max(0.02, mic.floor * 3);
    if (rms > thr) {
      Object.assign(mic, { active: true, chunks: [...mic.pre], speechMs: 0, silenceMs: 0, thr });
      setHearing(true);
    }
    return;
  }
  mic.chunks.push(copy);
  mic.speechMs += ms;
  mic.silenceMs = rms < mic.thr * 0.6 ? mic.silenceMs + ms : 0;
  if (mic.silenceMs > 900 || mic.speechMs > 15000) {
    const voiced = mic.speechMs - mic.silenceMs;
    const chunks = mic.chunks;
    Object.assign(mic, { active: false, chunks: [], pre: [] });
    setHearing(false);
    if (voiced > 400) sendClip(chunks);
  }
}

function sendClip(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-1, Math.min(1, c[i])) * 0x7fff;
  }
  freedom.voiceClip(new Uint8Array(pcm.buffer), SAMPLE_RATE);
}

// ---------- wire up ----------
freedom.onState((s) => {
  const wasExpanded = state?.expanded;
  state = s;
  if (s.expanded && !wasExpanded) fillSettings();
  render();
});
freedom.getState().then((s) => { state = s; fillSettings(); render(); });
setInterval(render, 30000); // keep "x min ago" fresh
