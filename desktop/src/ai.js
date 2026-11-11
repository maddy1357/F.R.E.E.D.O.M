// Picks the AI provider: Gemini (free tier, default) or Claude (paid API).
const claude = require('./claude');
const gemini = require('./gemini');

const PROVIDERS = {
  gemini: { label: 'Google Gemini (free)', model: gemini.GEMINI_MODELS.join(' → '), keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  claude: { label: 'Anthropic Claude (paid)', model: claude.MODEL, keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys', env: ['ANTHROPIC_API_KEY'] },
};

function askAboutScreen({ provider, ...args }) {
  return provider === 'claude' ? claude.askAboutScreen(args) : gemini.askGemini(args);
}

function describeError(err) {
  return gemini.describeGeminiError(err) || claude.describeError(err);
}

module.exports = { askAboutScreen, describeError, PROVIDERS };
