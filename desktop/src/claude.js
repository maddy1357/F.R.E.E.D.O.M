const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, buildUserText } = require('./prompt');

const MODEL = 'claude-opus-5-5';

/**
 * Send one screenshot (JPEG, base64) to Claude and get back a short answer.
 * Returns { text } where text is null when Claude decided there is nothing to say.
 */
async function askAboutScreen({ apiKey, imageBase64, question, previousAnswer, effort = 'low' }) {
  const client = new Anthropic({ apiKey: apiKey || undefined });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort },
    // If a safety classifier declines, the API retries on a suitable model in the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: buildUserText({ question, previousAnswer }) },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation;
    return { text: `I can't help with what's on screen right now.${why ? ` (${why})` : ''}`, refused: true };
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  if (!text || (!question && /^NOTHING\.?$/i.test(text))) return { text: null };
  return { text };
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid API key — open ⚙️ settings and paste a valid key.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key cannot use this model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited — slowing down. Try a longer interval.';
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIError && err.status) return `API error ${err.status}: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'No connection to the Claude API. Check your internet.';
  return err?.message || String(err);
}

module.exports = { askAboutScreen, describeError, MODEL };
