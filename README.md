# 👀 F.R.E.E.D.O.M

A floating emoji ball, like Assistive Touch, that sits on top of your screen, keeps watching what you're doing, and answers what you're looking at: a question, an error, a bug, or a form. It uses Claude's vision model.

**Try it in your browser:** https://maddy1357.github.io/F.R.E.E.D.O.M/

| The ball | Meaning |
|---|---|
| 👀 | Watching your screen |
| 🤔 | Thinking (sent a picture of your screen to Claude) |
| 💡 + green dot | A new answer is ready. Tap the ball to read it |
| 😴 | Paused |
| 🔑 | Needs an Anthropic API key |
| ⚠️ | Something went wrong. Open the ball to see what |

## How it works

1. Every few seconds it takes a tiny 64×36 snapshot of the screen and compares it with the last one it sent.
2. When the screen has **changed** and then **stopped changing** (you finished scrolling or typing), it sends one full screenshot to Claude (`claude-opus-5-5`).
3. Claude answers the most useful thing on screen, or replies `NOTHING` when there is nothing worth saying. In that case the ball stays quiet.
4. You can also type a question in the panel ("what's wrong with this code?"). That takes a fresh screenshot and asks right away.

A minimum gap between calls (12 s by default) limits how often it sends screenshots, and how much it costs.

## Two ways to run it

### 🖥️ Desktop app

Works on Windows, macOS and Linux. It floats over **every** app and watches the entire screen continuously.

```bash
cd desktop
npm install
npm start
```

- **Click** the ball to open the answer panel. **Drag** it anywhere. **Right-click** it for pause, ask now, or quit.
- **Ctrl+Shift+Space** (Cmd+Shift+Space on a Mac) makes it look at the screen and answer right now.
- On first run, open ⚙️ and paste your Anthropic API key. It's stored encrypted with your operating system's keychain. Alternatively, set `ANTHROPIC_API_KEY` before starting.
- On macOS, allow **Screen Recording** for the app the first time (System Settings → Privacy & Security).
- It watches the screen the ball is on. Its own ball and panel are left out of the change detection.
- To build an installer (`.exe` / `.dmg` / `.AppImage`), run `npm run dist` in the `desktop` folder. The output goes to `desktop/dist/`.

### 🌐 Web app (phones, tablets, any browser)

Open https://maddy1357.github.io/F.R.E.E.D.O.M/ or run it locally:

```bash
cd web
npm install
npm run dev
```

Tap the ball, paste your API key (it's saved only in that browser), then pick a source:

| Source | Where it works | What it watches |
|---|---|---|
| 📺 **Screen** | Laptop/desktop Chrome, Edge, Firefox, Safari | Your entire screen. Pick "Entire screen" when the browser asks |
| 📷 **Camera** | Phones and tablets (and laptops) | Whatever you point the camera at: another screen, a book, a whiteboard |
| 🖼️ **Photo** | Everywhere | A single screenshot or photo |
| ⧉ **Pop out** | Desktop Chrome and Edge | Moves the panel into a small always-on-top window that floats over every app |

On a phone, use **Add to Home Screen** to open it like an app.

> **About phones:** Android and iOS don't let a web page draw over other apps or read their screens. Inside the browser, the ball floats over the page, and the camera or a screenshot lets it see things. A true system-wide bubble over every app on Android would need a native Android app (overlay permission + MediaProjection). iOS doesn't allow that at all.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Look every | 4 s | How often it checks whether the screen changed. Checking is free, since nothing is sent |
| Min gap | 12 s | Minimum time between two automatic Claude calls |
| Thinking effort | Low | `low` is fastest; `high` is smartest but slower and uses more tokens |

Requests use Claude's server-side refusal fallback (`fallbacks: "default"`). If a safety check declines a request, the API retries it on a suitable model within the same call.

## Privacy and cost

- Each automatic look sends **one screenshot of your screen** to the Anthropic API with your key. Pause with ⏸ (or right-click → Pause) before showing anything private.
- No server of ours is involved. The desktop app talks to `api.anthropic.com` directly. The web app does the same from your browser, and the key stays in that browser's storage.
- The ball is always visible while it's watching.

## Project layout

```
desktop/              Electron app (always-on-top ball over every app)
  src/main.js         window, screen capture, change detection, watch loop
  src/claude.js       Claude API call (@anthropic-ai/sdk)
  src/prompt.js       what F.R.E.E.D.O.M is told to do with a screenshot
  src/renderer/       the ball + answer panel UI
web/                  Browser / phone version (Vite), deployed to GitHub Pages
  src/main.js         ball, panel, screen/camera/photo capture, pop-out
  src/claude.js       same Claude call, from the browser
.github/workflows/    builds web/ and publishes it to GitHub Pages
```

## License

MIT
