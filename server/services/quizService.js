// Assessment: generate source-grounded MCQs, keep the answer key server-side,
// grade deterministically (string comparison, no AI), update the learner model.

import { chatCompletion } from './nimChat.js';
import { retrieve, toCitation } from './retrieval.js';
import { applyAttempt } from './learner.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { newId, nowIso } from '../store/sqlite.js';

const CHOICE_IDS = ['a', 'b', 'c', 'd'];
const MAX_ATTEMPTS = 2; // bounded retries when the model returns unusable JSON

// ---------- pure helpers (exported for tests) ----------

export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Validate one raw question from the model. Returns a normalized question or null.
export function normalizeQuestion(raw, { topic }) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (text.length < 10 || text.length > 400) return null;

  if (!Array.isArray(raw.choices) || raw.choices.length !== 4) return null;
  const choices = raw.choices.map((c) => (typeof c === 'string' ? c.trim() : ''));
  if (choices.some((c) => c.length === 0 || c.length > 200)) return null;
  if (new Set(choices.map((c) => c.toLowerCase())).size !== 4) return null; // no duplicates

  const answerText = typeof raw.answer === 'string' ? raw.answer.trim() : '';
  const answerIndex = choices.findIndex((c) => c.toLowerCase() === answerText.toLowerCase());
  if (answerIndex === -1) return null;

  const explanation = typeof raw.explanation === 'string' && raw.explanation.trim() !== ''
    ? raw.explanation.trim().slice(0, 500)
    : `The correct answer is "${choices[answerIndex]}".`;

  return {
    topic: topic.trim(),
    text: text.slice(0, 400),
    choices: CHOICE_IDS.map((id, i) => ({ id, text: choices[i] })),
    correctChoiceId: CHOICE_IDS[answerIndex],
    explanation,
    // Only passage indexes the model may reference; invalid ones are dropped later.
    cite: Array.isArray(raw.cite) ? raw.cite.filter((n) => Number.isInteger(n) && n >= 1) : [],
  };
}

export function gradeAnswers(questionRows, answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Submit an "answers" array with one entry per question.');
  }

  // Validate every submission before grading anything.
  const seen = new Set();
  for (const a of answers) {
    if (!a || !Number.isInteger(a.index) || a.index < 0 || a.index >= questionRows.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Each answer needs a valid question "index".');
    }
    if (seen.has(a.index)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Question ${a.index} was answered more than once.`);
    }
    seen.add(a.index);
    if (a.choiceId !== null && !CHOICE_IDS.includes(a.choiceId)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Answer for question ${a.index} must be one of a, b, c, d or null.`);
    }
  }

  let correct = 0;
  const perQuestion = questionRows.map((q) => {
    const submitted = answers.find((a) => a.index === q.idx);
    const yourChoiceId = submitted && submitted.choiceId !== null ? submitted.choiceId : null;
    const isCorrect = yourChoiceId === q.correct_choice_id;
    if (isCorrect) correct += 1;
    return {
      index: q.idx,
      yourChoiceId,
      correctChoiceId: q.correct_choice_id,
      correct: isCorrect,
      explanation: q.explanation,
      citations: JSON.parse(q.citations_json),
    };
  });

  return { correct, total: questionRows.length, perQuestion };
}

function citationsForQuestion(hits, citeIndexes) {
  const picked = [];
  for (const n of citeIndexes.slice(0, 3)) {
    if (hits[n - 1]) picked.push(toCitation(hits[n - 1]));
  }
  if (picked.length === 0) picked.push(...hits.slice(0, 2).map(toCitation));
  return picked;
}

// ---------- generation ----------

async function generateQuestionBatch({ topic, difficulty, count, evidence }, chat) {
  const systemPrompt = [
    'You write multiple-choice quiz questions strictly from the passages provided.',
    `Topic: ${topic}. Difficulty: ${difficulty}.`,
    'Return ONLY a JSON object, no other text, in exactly this shape:',
    '{"questions":[{"question":"...","choices":["...","...","...","..."],"answer":"the exact correct choice text","explanation":"1-3 sentences explaining why","cite":[1,2]}]}',
    'Rules: exactly 4 unique choices; "answer" must match one choice exactly; "cite" lists passage numbers that support the question (1-based); every question must be answerable from the passages alone.',
  ].join('\n');

  const content = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Passages:\n\n${evidence}\n\nWrite ${count} question${count === 1 ? '' : 's'}.` },
  ], { model: config.nimAssessModel, maxTokens: 2000 });

  const parsed = parseJsonLoose(content);
  if (!parsed || !Array.isArray(parsed.questions)) return [];
  return parsed.questions
    .map((raw) => normalizeQuestion(raw, { topic }))
    .filter(Boolean);
}

export async function generateQuiz({ topic, questionCount = 5, difficulty, sourceIds = [] }, { db, ai, vector }) {
  const chat = ai?.chatCompletion ?? chatCompletion;
  const hits = await retrieve(`${topic}`, { sourceIds, k: 8, ai, vector });

  if (hits.length === 0) {
    throw new ApiError(422, 'QUIZ_CONTENT_INVALID',
      'Not enough indexed material on this topic yet. Upload relevant material or pick another topic.');
  }

  const evidence = hits
    .map((hit, i) => {
      const meta = hit.metadata ?? {};
      const where = meta.page != null ? `p.${meta.page}` : meta.slide != null ? `s.${meta.slide}` : '';
      return `Passage ${i + 1} [${meta.title ?? 'source'}${where ? ' ' + where : ''}]:\n${hit.text}`;
    })
    .join('\n\n');

  const accepted = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS && accepted.length < questionCount; attempt++) {
    const batch = await generateQuestionBatch({ topic, difficulty, count: questionCount, evidence }, chat);
    for (const q of batch) {
      if (accepted.length >= questionCount) break;
      // De-duplicate by question text within the quiz.
      if (accepted.some((a) => a.text.toLowerCase() === q.text.toLowerCase())) continue;
      accepted.push(q);
    }
  }

  if (accepted.length === 0) {
    throw new ApiError(422, 'QUIZ_CONTENT_INVALID',
      'The quiz model could not produce valid questions from this material. Try a broader topic or upload more material.');
  }

  // Persist with the answer key (server-side only).
  const quizId = newId('quiz');
  const createdAt = nowIso();
  db.prepare('INSERT INTO quizzes (id, topic, difficulty, question_count, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(quizId, topic.trim(), difficulty, accepted.length, createdAt);

  const insertQuestion = db.prepare(
    'INSERT INTO quiz_questions (quiz_id, idx, text, choices_json, correct_choice_id, explanation, citations_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const responseQuestions = accepted.map((q, idx) => {
    const citations = citationsForQuestion(hits, q.cite);
    insertQuestion.run(quizId, idx, q.text, JSON.stringify(q.choices), q.correctChoiceId, q.explanation, JSON.stringify(citations));
    // Strip the key before it ever reaches the response.
    return { index: idx, text: q.text, choices: q.choices, citations };
  });

  return { id: quizId, topic: topic.trim(), difficulty, questions: responseQuestions };
}
