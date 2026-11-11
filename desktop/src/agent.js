// Full Auto mode: the AI looks at the screen and operates mouse + keyboard to finish a task.
// One action per turn; after every action it gets a fresh screenshot.
// Safety: it must call ask_user before paying, entering secrets, sending, deleting, or anything
// irreversible, and the user can stop it at any moment.
const { GoogleGenAI, ApiError } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');
const { GEMINI_MODELS } = require('./gemini');
const { MODEL: CLAUDE_MODEL } = require('./claude');

const MAX_STEPS = 40;
const SETTLE_MS = 900; // wait for the screen to react before the next screenshot

const SYSTEM = `You are F.R.E.E.D.O.M in Full Auto mode. You operate the user's computer (Windows) to complete the task they gave you.
You see a screenshot after every action. Coordinates are normalised: x and y go from 0 (left/top) to 1000 (right/bottom) of the screenshot.

How to work:
- Do exactly one action per turn, then look at the new screenshot to check it worked.
- To visit a website, use open_url (it opens the default browser) instead of typing into the address bar.
- Click into a text field before typing into it. Use type_text with submit=true to press Enter afterwards.
- If a page is loading, use wait. If something didn't work, try a different way; don't repeat the same failing action.
- Every action needs a short "note" in plain words that tells the user what you are doing ("Typing Delhi into From").
- The round emoji ball and the F.R.E.E.D.O.M panel are you. Never click them.

Safety rules (always follow):
- Call ask_user and wait for the answer BEFORE: paying or confirming a purchase or booking, entering card / bank / UPI details, typing passwords or OTPs, signing in, sending an email or message, posting publicly, deleting anything, or changing account settings.
- Never type passwords, card numbers, OTPs or other secrets yourself. Ask the user to type them, then continue when they say they're done.
- When there are choices the user didn't specify (date, time, price, seat, airline), pick a sensible default only if it costs nothing to change; otherwise ask_user with 2–3 concrete options.
- Call finish when the task is done, impossible, or the user says no. Say what you did and what is left for the user.`;

const NOTE = { type: 'string', description: 'What you are doing, in a few plain words, shown to the user.' };
const TOOLS = [
  { name: 'click', description: 'Click at a point on the screen.', parameters: { type: 'object', properties: { x: { type: 'number', description: '0-1000 from the left' }, y: { type: 'number', description: '0-1000 from the top' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' }, note: NOTE }, required: ['x', 'y', 'note'] } },
  { name: 'type_text', description: 'Type text into the focused field.', parameters: { type: 'object', properties: { text: { type: 'string' }, submit: { type: 'boolean', description: 'Press Enter after typing' }, note: NOTE }, required: ['text', 'note'] } },
  { name: 'press_keys', description: 'Press a key or key combination, e.g. "enter", "tab", "ctrl+l", "alt+tab", "win", "esc", "down".', parameters: { type: 'object', properties: { keys: { type: 'string' }, note: NOTE }, required: ['keys', 'note'] } },
  { name: 'scroll', description: 'Scroll at a point.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number', description: '1-10 wheel notches' }, note: NOTE }, required: ['x', 'y', 'direction', 'note'] } },
  { name: 'open_url', description: 'Open a web address in the default browser.', parameters: { type: 'object', properties: { url: { type: 'string' }, note: NOTE }, required: ['url', 'note'] } },
  { name: 'wait', description: 'Wait for the screen to finish loading.', parameters: { type: 'object', properties: { seconds: { type: 'number', description: '1-10' }, note: NOTE }, required: ['seconds', 'note'] } },
  { name: 'ask_user', description: 'Ask the user a question or for permission, and wait for the answer.', parameters: { type: 'object', properties: { question: { type: 'string', description: 'Short question. Offer concrete options when useful.' } }, required: ['question'] } },
  { name: 'finish', description: 'End the task.', parameters: { type: 'object', properties: { success: { type: 'boolean' }, summary: { type: 'string', description: 'One or two sentences: what was done and anything left for the user.' } }, required: ['success', 'summary'] } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- provider adapters: same interface, different wire formats ----------
class GeminiAgentChat {
  constructor({ apiKey, effort }) {
    this.ai = new GoogleGenAI({ apiKey });
    this.effort = effort;
    this.contents = [];
    this.models = [...GEMINI_MODELS];
  }

  async request(parts) {
    this.contents.push({ role: 'user', parts });
    for (;;) {
      try {
        const res = await this.ai.models.generateContent({
          model: this.models[0],
          contents: this.contents,
          config: {
            systemInstruction: SYSTEM,
            maxOutputTokens: 4096,
            tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
            thinkingConfig: { thinkingLevel: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }[this.effort] || 'LOW' },
          },
        });
        const content = res.candidates?.[0]?.content;
        if (content) this.contents.push(content); // keeps thought signatures intact
        const calls = (res.functionCalls || []).map((c) => ({ id: c.id, name: c.name, args: c.args || {} }));
        const text = (content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
        return { calls, text };
      } catch (err) {
        if (err instanceof ApiError && [403, 404].includes(err.status) && this.models.length > 1) { this.models.shift(); continue; }
        throw err;
      }
    }
  }

  start(task, shot) {
    return this.request([{ text: task }, { inlineData: { mimeType: 'image/jpeg', data: shot } }]);
  }

  results(results, shot) {
    return this.request(results.map((r, i) => ({
      functionResponse: {
        id: r.id,
        name: r.name,
        response: r.output,
        ...(i === results.length - 1 ? { parts: [{ inlineData: { mimeType: 'image/jpeg', data: shot } }] } : {}),
      },
    })));
  }

  nudge(text, shot) {
    return this.request([{ text }, { inlineData: { mimeType: 'image/jpeg', data: shot } }]);
  }
}

class ClaudeAgentChat {
  constructor({ apiKey, effort }) {
    this.client = new Anthropic({ apiKey });
    this.effort = effort;
    this.messages = [];
  }

  async request(content) {
    this.messages.push({ role: 'user', content });
    const res = await this.client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      output_config: { effort: this.effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: this.messages,
    });
    this.messages.push({ role: 'assistant', content: res.content }); // full content, unchanged
    if (res.stop_reason === 'refusal') throw new Error('Claude declined this task.');
    const calls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { calls, text };
  }

  image(shot) { return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot } }; }

  start(task, shot) { return this.request([{ type: 'text', text: task }, this.image(shot)]); }

  results(results, shot) {
    return this.request(results.map((r, i) => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: [{ type: 'text', text: JSON.stringify(r.output) }, ...(i === results.length - 1 ? [this.image(shot)] : [])],
      ...(r.output.error ? { is_error: true } : {}),
    })));
  }

  nudge(text, shot) { return this.request([{ type: 'text', text }, this.image(shot)]); }
}

// ---------- the agent ----------
class AutoAgent {
  /**
   * @param {object} o
   * @param {'gemini'|'claude'} o.provider
   * @param {() => Promise<{jpeg: string, toScreen: (x:number,y:number)=>{x:number,y:number}, isOwnWindow: (x:number,y:number)=>boolean}>} o.capture
   * @param {import('./input-win').WinInput} o.input
   * @param {(url:string)=>Promise<void>} o.openUrl
   * @param {(question:string)=>Promise<string>} o.askUser   resolves with the user's answer
   * @param {(step:{icon:string,text:string})=>void} o.onStep
   */
  constructor(o) {
    Object.assign(this, o);
    this.stopped = false;
    this.chat = o.provider === 'claude' ? new ClaudeAgentChat(o) : new GeminiAgentChat(o);
  }

  stop() { this.stopped = true; }

  async run(task) {
    let shot = await this.capture();
    let turn = await this.chat.start(`Task from the user: ${task}\n\nHere is the screen right now.`, shot.jpeg);
    let idle = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.stopped) return { success: false, summary: 'Stopped by you.' };
      if (!turn.calls.length) {
        if (turn.text) this.onStep({ icon: '💬', text: turn.text });
        if (++idle > 2) return { success: false, summary: turn.text || 'I got stuck and stopped.' };
        turn = await this.chat.nudge('Continue the task using one of the tools. If it is done or impossible, call finish.', shot.jpeg);
        continue;
      }
      idle = 0;
      const results = [];
      for (const call of turn.calls) {
        if (this.stopped) return { success: false, summary: 'Stopped by you.' };
        if (call.name === 'finish') return { success: Boolean(call.args.success), summary: String(call.args.summary || '') };
        results.push({ id: call.id, name: call.name, output: await this.execute(call, shot) });
      }
      await sleep(SETTLE_MS);
      if (this.stopped) return { success: false, summary: 'Stopped by you.' };
      shot = await this.capture();
      turn = await this.chat.results(results, shot.jpeg);
    }
    return { success: false, summary: `Stopped after ${MAX_STEPS} steps without finishing.` };
  }

  async execute({ name, args }, shot) {
    const note = String(args.note || '').slice(0, 140);
    const num = (v, d) => (Number.isFinite(+v) ? Math.min(1000, Math.max(0, +v)) : d);
    try {
      switch (name) {
        case 'click': {
          const nx = num(args.x, 500); const ny = num(args.y, 500);
          if (shot.isOwnWindow(nx, ny)) return { error: 'That point is the F.R.E.E.D.O.M ball itself. Click somewhere else.' };
          const p = shot.toScreen(nx, ny);
          this.onStep({ icon: '🖱️', text: note || `Click at ${nx}, ${ny}` });
          await this.input.click(p.x, p.y, args.button === 'right' ? 'right' : 'left', args.double ? 2 : 1);
          return { ok: true };
        }
        case 'type_text': {
          this.onStep({ icon: '⌨️', text: note || `Type "${String(args.text).slice(0, 40)}"` });
          await this.input.type(String(args.text ?? ''));
          if (args.submit) await this.input.keys('enter');
          return { ok: true };
        }
        case 'press_keys': {
          this.onStep({ icon: '⌨️', text: note || `Press ${args.keys}` });
          await this.input.keys(String(args.keys));
          return { ok: true };
        }
        case 'scroll': {
          const p = shot.toScreen(num(args.x, 500), num(args.y, 500));
          const amount = Math.min(10, Math.max(1, Math.round(+args.amount || 3)));
          this.onStep({ icon: '🖱️', text: note || `Scroll ${args.direction}` });
          await this.input.scroll(p.x, p.y, args.direction === 'up' ? amount : -amount);
          return { ok: true };
        }
        case 'open_url': {
          let url = String(args.url || '').trim();
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          const u = new URL(url);
          if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Only http and https addresses can be opened.' };
          this.onStep({ icon: '🌐', text: note || `Open ${u.host}` });
          await this.openUrl(u.toString());
          await sleep(2500);
          return { ok: true };
        }
        case 'wait': {
          const s = Math.min(10, Math.max(1, +args.seconds || 2));
          this.onStep({ icon: '⏳', text: note || `Wait ${s}s` });
          await sleep(s * 1000);
          return { ok: true };
        }
        case 'ask_user': {
          const q = String(args.question || 'Should I continue?');
          this.onStep({ icon: '❓', text: q });
          const answer = await this.askUser(q);
          return { answer };
        }
        default:
          return { error: `Unknown tool ${name}` };
      }
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }
}

module.exports = { AutoAgent, TOOLS, SYSTEM };
