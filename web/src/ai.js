// Picks the AI provider: Gemini (free tier, default) or Claude (paid API).
// Each provider's SDK is loaded only when it is first used, so phones download less.

export const PROVIDERS = {
  gemini: { label: 'Google Gemini (free)', model: 'gemini-3.8-flash → gemini-3.6-flash', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
  claude: { label: 'Anthropic Claude (paid)', model: 'claude-opus-5-5', keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys' },
};

const loaded = {};
const load = {
  gemini: () => import('./gemini.js'),
  claude: () => import('./claude.js'),
};

export async function askAboutScreen({ provider, ...args }) {
  const p = provider === 'claude' ? 'claude' : 'gemini';
  loaded[p] ??= await load[p]();
  return p === 'claude' ? loaded.claude.askAboutScreen(args) : loaded.gemini.askGemini(args);
}

export function describeError(err) {
  return loaded.gemini?.describeGeminiError(err)
    || loaded.claude?.describeError(err)
    || err?.message
    || String(err);
}
