const { GoogleGenAI, ApiError } = require('@google/genai');
const { SYSTEM_PROMPT, buildUserText } = require('./prompt');

// Free-tier Gemini models. The first one is tried first; if it isn't available
// for this key/region (404/403), the stable fallback is used.
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];
const LEVEL = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };

let workingModel = null;

async function askGemini({ apiKey, imageBase64, question, previousAnswer, tasks, effort = 'low' }) {
  const ai = new GoogleGenAI({ apiKey });
  const models = workingModel ? [workingModel] : GEMINI_MODELS;
  let lastErr;
  for (const model of models) {
    try {
      const text = await generate(ai, model, { imageBase64, question, previousAnswer, tasks, effort });
      workingModel = model;
      if (!text || (!question && /^NOTHING\.?$/i.test(text))) return { text: null, model };
      return { text, model };
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ApiError && [403, 404].includes(err.status))) throw err;
    }
  }
  throw lastErr;
}

async function generate(ai, model, { imageBase64, question, previousAnswer, tasks, effort }, withThinking = true) {
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
          { text: buildUserText({ question, previousAnswer, tasks }) },
        ],
      }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 4096,
        ...(withThinking ? { thinkingConfig: { thinkingLevel: LEVEL[effort] || 'LOW' } } : {}),
      },
    });
    const blocked = res.promptFeedback?.blockReason;
    if (blocked) return `I can't help with what's on screen right now. (${blocked})`;
    return (res.text || '').trim();
  } catch (err) {
    // Some models don't accept a thinking level — retry once without it.
    if (withThinking && err instanceof ApiError && err.status === 400 && /thinking/i.test(err.message)) {
      return generate(ai, model, { imageBase64, question, previousAnswer, tasks, effort }, false);
    }
    throw err;
  }
}

function describeGeminiError(err) {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 400 && /api key/i.test(err.message)) return 'Invalid Gemini API key — open ⚙️ settings and paste a valid key.';
  if (err.status === 401 || err.status === 403) return 'This Gemini API key was rejected. Create a new free key at aistudio.google.com/apikey.';
  if (err.status === 429) return 'Free-tier limit reached — slowing down. Try a longer "Min gap", or wait a minute.';
  return `Gemini error ${err.status}: ${err.message}`;
}

module.exports = { askGemini, describeGeminiError, GEMINI_MODELS };
