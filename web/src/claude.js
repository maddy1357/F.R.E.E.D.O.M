import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserText } from './prompt.js';

export const MODEL = 'claude-opus-5-5';

/**
 * Send one JPEG (base64, no data: prefix) to Claude.
 * Runs in the browser with the user's own key, which never leaves their device except to api.anthropic.com.
 * Returns { text } — text is null when Claude decided there is nothing worth saying.
 */
export async function askAboutScreen({ apiKey, imageBase64, question, previousAnswer, tasks, effort = 'low' }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

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
          { type: 'text', text: buildUserText({ question, previousAnswer, tasks }) },
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

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid API key — open ⚙️ settings and paste a valid key.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key cannot use this model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited — slowing down. Try a longer interval.';
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIError && err.status) return `API error ${err.status}: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'No connection to the Claude API. Check your internet.';
  return err?.message || String(err);
}
