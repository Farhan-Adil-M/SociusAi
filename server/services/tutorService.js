// Tutoring: retrieve grounded passages, ask the model to answer ONLY from them,
// return the answer with citations mapped from real retrieved metadata.

import { chatCompletion } from './nimChat.js';
import { retrieve, toCitation } from './retrieval.js';
import { config } from '../config.js';

const ABSTAIN_MESSAGE = "I couldn't find enough in your study materials to answer that. "
  + 'Try adding material on this topic, or ask about something covered in your sources.';

function passageLabel(hit) {
  const meta = hit.metadata ?? {};
  const where = meta.page != null ? `page ${meta.page}`
    : meta.slide != null ? `slide ${meta.slide}`
      : meta.paragraph != null ? `paragraph ${meta.paragraph}` : 'no location';
  return `[${meta.title ?? 'source'} — ${where}]`;
}

export async function answerQuestion({ question, sourceIds = [], db }, { ai, vector } = {}) {
  const hits = await retrieve(question, { sourceIds, ai, vector });

  if (hits.length === 0) {
    return { answer: ABSTAIN_MESSAGE, citations: [], needsContent: true, model: config.nimChatModel };
  }

  const evidence = hits
    .map((hit, i) => `Passage ${i + 1} ${passageLabel(hit)}:\n${hit.text}`)
    .join('\n\n');

  const systemPrompt = [
    'You are Socius AI, a tutor who answers strictly from the passages the student provides.',
    'Rules:',
    '- Use ONLY the information in the passages. If the passages do not contain the answer, say you could not find it in the study materials.',
    '- Write a clear, concise explanation a student can understand.',
    '- After your explanation, cite your sources inline like [1] or [2][3], matching the passage numbers.',
    'Never invent facts, filenames, page numbers, or sources.',
  ].join('\n');

  const chat = ai?.chatCompletion ?? chatCompletion;
  const answer = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Passages:\n\n${evidence}\n\nStudent question: ${question}` },
  ], { model: config.nimChatModel });

  return {
    answer,
    citations: hits.map(toCitation),
    needsContent: false,
    model: config.nimChatModel,
  };
}
