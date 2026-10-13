// Tutoring: retrieve grounded passages, ask the model to answer ONLY from them,
// return the answer with citations mapped from real retrieved metadata.

import { chatCompletion } from './nimChat.js';
import { retrieve, toCitation } from './retrieval.js';
import { wrapPassages, UNTRUSTED_RULE } from './prompts.js';
import { config } from '../config.js';

const ABSTAIN_MESSAGE = "I couldn't find enough in your study materials to answer that. "
  + 'Try adding material on this topic, or ask about something covered in your sources.';
const MODEL_ABSTAIN_TOKEN = 'EVIDENCE_INSUFFICIENT';


export async function answerQuestion({ question, sourceIds = [], db }, { ai, vector } = {}) {
  const hits = await retrieve(question, { sourceIds, ai, vector });

  if (hits.length === 0) {
    return { answer: ABSTAIN_MESSAGE, citations: [], needsContent: true, model: config.nimChatModel };
  }

  const evidence = wrapPassages(hits);

  const systemPrompt = [
    'You are Socius AI, a tutor who answers strictly from the passages the student provides.',
    'Rules:',
    UNTRUSTED_RULE,
    '- Use ONLY the information in the passages. If the passages do not contain the answer, say you could not find it in the study materials.',
    '- Write a clear, concise explanation a student can understand.',
    '- After your explanation, cite your sources inline like [1] or [2][3], matching the passage numbers.',
    `- If the passages do not contain enough information to answer, reply with exactly ${MODEL_ABSTAIN_TOKEN} and nothing else — do not use outside knowledge.`,
    'Never invent facts, filenames, page numbers, or sources.',
  ].join('\n');

  const chat = ai?.chatCompletion ?? chatCompletion;
  const answer = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Passages:\n\n${evidence}\n\nStudent question: ${question}` },  ], { model: config.nimChatModel });

  // The grounding contract with the model: an explicit refusal token means the
  // passages did not cover the question — abstain honestly instead of trusting
  // outside knowledge it may have used anyway.
  if (answer.trim().toUpperCase() === MODEL_ABSTAIN_TOKEN) {
    return { answer: ABSTAIN_MESSAGE, citations: [], needsContent: true, model: config.nimChatModel };
  }

  return {
    answer,
    citations: hits.map(toCitation),
    needsContent: false,
    model: config.nimChatModel,
  };
}
