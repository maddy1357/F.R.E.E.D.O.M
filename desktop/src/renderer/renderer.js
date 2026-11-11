/* global freedom */
const $ = (id) => document.getElementById(id);

const EMOJI = {
  idle: '🙂', watching: '👀', thinking: '🤔', answer: '💡', paused: '😴', error: '⚠️', nokey: '🔑',
};
const STATUS_TEXT = {
  idle: 'ready', watching: 'watching your screen', thinking: 'thinking…', answer: 'new answer',
  paused: 'paused', error: 'something went wrong', nokey: 'needs an API key',
};

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
  $('emoji').textContent = EMOJI[state.status] || '🙂';
  $('dot').hidden = !state.unread || state.expanded;

  $('panel').hidden = !state.expanded;
  if (!state.expanded) return;

  $('statusText').textContent = STATUS_TEXT[state.status] || state.status;
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
           ${state.settings.auto ? 'Watching your screen. When something needs an answer, it shows up here.' : 'Paused. Ask a question below, or press ▶ to keep watching.'}
           <br><br>Shortcut: <kbd>${escapeHtml(state.hotkey)}</kbd></div>`
      : '<div class="empty"><span class="big">🔑</span>Paste your Anthropic API key above to start.</div>';
  } else {
    box.innerHTML = state.answers.map((a, i) => `
      <article class="answer">
        <div class="meta">
          <span>${a.question ? '❓ ' + escapeHtml(a.question) : '👀 from your screen'} · ${timeAgo(a.at)}</span>
          <button class="copy" data-i="${i}">Copy</button>
        </div>
        <div class="body">${renderMarkdown(a.text)}</div>
      </article>`).join('');
  }
}

function fillSettings() {
  if (!state) return;
  $('apiKey').value = state.settings.apiKey || '';
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
    apiKey: $('apiKey').value,
    intervalSec: $('intervalSec').value,
    minGapSec: $('minGapSec').value,
    effort: $('effort').value,
  });
  settingsOpen = false;
};
$('clearKeyBtn').onclick = () => { freedom.saveSettings({ clearKey: true }); $('apiKey').value = ''; };
$('quitBtn').onclick = () => freedom.quit();
$('askForm').onsubmit = (e) => {
  e.preventDefault();
  freedom.ask($('question').value);
  $('question').value = '';
};
$('answers').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  navigator.clipboard.writeText(state.answers[+btn.dataset.i].text);
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') freedom.collapse(); });

// ---------- wire up ----------
freedom.onState((s) => {
  const wasExpanded = state?.expanded;
  state = s;
  if (s.expanded && !wasExpanded) fillSettings();
  render();
});
freedom.getState().then((s) => { state = s; fillSettings(); render(); });
setInterval(render, 30000); // keep "x min ago" fresh
