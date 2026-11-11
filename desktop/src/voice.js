// Turns a short voice clip into something F.R.E.E.D.O.M can act on:
// a new task, a command (mode switch, stop, yes/no), a question about the screen, or chat.
// Uses Gemini (free tier) because it understands audio directly — no separate speech-to-text.
const { GoogleGenAI, ApiError } = require('@google/genai');
const { GEMINI_MODELS } = require('./gemini');

const SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'What the user said, in their language.' },
    intent: {
      type: 'string',
      enum: ['add_task', 'command', 'answer_question', 'ask_about_screen', 'chat', 'ignore'],
    },
    task: { type: 'string', description: 'For add_task: the task as a short clear instruction, e.g. "Book a flight from Delhi to Bengaluru".' },
    command: {
      type: 'string',
      enum: ['help_mode', 'auto_mode', 'narrative_on', 'narrative_off', 'stop', 'pause', 'resume', 'start_tasks', 'clear_done', 'none'],
    },
    answer: { type: 'string', description: 'For answer_question: the user\'s answer to the pending question, e.g. "yes", "no", "the 9 am flight".' },
    question: { type: 'string', description: 'For ask_about_screen: the question about what is on screen.' },
    reply: { type: 'string', description: 'For chat: a short friendly spoken reply (1-2 sentences).' },
  },
  required: ['transcript', 'intent'],
};

function instructions({ mode, pendingQuestion, tasks }) {
  return `You are the voice input of F.R.E.E.D.O.M, a desktop assistant. The audio is what the microphone just heard.
Current mode: ${mode === 'auto' ? 'Full Auto (it operates the computer to do tasks)' : 'Help (it watches the screen and gives suggestions)'}.
${pendingQuestion ? `The assistant is waiting for the user's answer to: "${pendingQuestion}". If the user is answering it (yes / no / a choice / "done"), use intent answer_question.` : ''}
Open tasks: ${tasks.length ? tasks.map((t) => `"${t}"`).join(', ') : 'none'}.

Decide the intent:
- add_task: the user wants something done or remembered ("book a flight from Delhi to Bengaluru", "remind me to email Ravi", "add buy milk").
- command: switching modes ("go to auto mode", "help mode", "narrate", "be quiet"), "stop", "pause", "resume", "start the tasks / do it", "clear finished tasks".
- answer_question: replying to the pending question.
- ask_about_screen: a question about what is on the screen ("what does this error mean?", "is this right?").
- chat: anything else said to the assistant.
- ignore: background noise, TV, music, other people talking, or speech not meant for the assistant.
Fill only the fields that the intent needs.`;
}

async function understandSpeech({ apiKey, wav, mode, pendingQuestion, tasks }) {
  const ai = new GoogleGenAI({ apiKey });
  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
            { text: instructions({ mode, pendingQuestion, tasks }) },
          ],
        }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: SCHEMA,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingLevel: 'LOW' },
        },
      });
      return JSON.parse(res.text || '{}');
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ApiError && [403, 404].includes(err.status))) throw err;
    }
  }
  throw lastErr;
}

// 16-bit mono PCM -> WAV file bytes
function pcmToWav(int16, sampleRate) {
  const data = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

module.exports = { understandSpeech, pcmToWav };
