// Mock fixtures — frontend-only demo data shaped exactly like docs/API_CONTRACT.md.
//
// Reached only when mock mode is on (?mock=1 or localStorage.socius_mock = '1'),
// and always labelled "Demo data" in the UI. Nothing here pretends to be a real
// AI answer: it is canned text, and the tutor abstains path is reproduced honestly.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const httpError = (code, message, status) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

/* ------------------------------------------------------------- fixtures */

const SOURCES = [
  { id: 'src_demo01', type: 'pdf', title: 'biology-photosynthesis.pdf', sizeLabel: '14 pages', chunkCount: 42, pageCount: 14, slideCount: null, createdAt: iso(-2) },
  { id: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', sizeLabel: '28 slides', chunkCount: 56, pageCount: null, slideCount: 28, createdAt: iso(-4) },
  { id: 'src_demo03', type: 'webpage', title: 'Khan Academy — Cell respiration', sizeLabel: 'webpage', chunkCount: 18, pageCount: null, slideCount: null, createdAt: iso(-6) },
];

function iso(daysAgo) {
  return new Date(Date.now() + daysAgo * 86400000).toISOString();
}

const citation = (over = {}) => ({
  sourceId: 'src_demo01',
  type: 'pdf',
  title: 'biology-photosynthesis.pdf',
  url: null,
  location: { page: 12 },
  excerpt: 'Chlorophyll absorbs light energy in the thylakoid membrane, where the light-dependent reactions convert water into oxygen, ATP, and NADPH.',
  score: 0.81,
  ...over,
});

const PHOTOSYNTHESIS_ANSWER = {
  answer: 'Photosynthesis happens in two stages. The light-dependent reactions take place in the thylakoid membranes, where chlorophyll absorbs sunlight and splits water into oxygen, ATP, and NADPH. The light-independent reactions (the Calvin cycle) then run in the stroma, using that ATP and NADPH to fix carbon dioxide into sugar.',
  citations: [
    citation(),
    citation({ sourceId: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', location: { slide: 9 }, excerpt: 'The thylakoid membrane hosts photosystem II and photosystem I; the stroma hosts the Calvin cycle enzymes.', score: 0.76 }),
  ],
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  needsContent: false,
};

const MITOSIS_ANSWER = {
  answer: 'Mitosis produces two genetically identical daughter cells and keeps the chromosome number the same, so it is used for growth and repair. Meiosis produces four genetically different cells with half the chromosome number, which is what makes sexual reproduction possible.',
  citations: [
    citation({ sourceId: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', location: { slide: 17 }, excerpt: 'Mitosis: one division, two identical diploid cells. Meiosis: two divisions, four unique haploid cells.', score: 0.84 }),
  ],
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  needsContent: false,
};

const ABSTAIN_ANSWER = {
  answer: "I couldn't find enough in your study materials to answer that. Try adding material on this topic, or ask about a topic covered in your sources.",
  citations: [],
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  needsContent: true,
};

const DEMO_BACKS = [
  'Chlorophyll is the pigment that absorbs light energy, mostly in the blue and red wavelengths, and passes it to the reaction centre of photosystem II.',
  'In the thylakoid membranes of the chloroplast, where photosystems II and I carry out electron transport.',
  'Carbon dioxide, ATP, and NADPH. The cycle fixes CO₂ into G3P using the energy carried by ATP and NADPH.',
  'Oxygen. It comes from the splitting of water during the light-dependent reactions.',
  'When rubisco binds O₂ instead of CO₂, the cycle loses fixed carbon and must burn extra ATP to recover it, which costs energy that would otherwise go to growth.',
  'It holds the enzymes of the Calvin cycle, including rubisco, so carbon fixation happens in the fluid surrounding the thylakoids.',
  '6CO₂ + 6H₂O + light energy → C₆H₁₂O₆ + 6O₂.',
  'They spatially separate initial carbon fixation from rubisco, so rubisco never sees a high O₂ concentration.',
];

const FLASHCARD_FRONTS = [
  'What role does chlorophyll play in photosynthesis?',
  'Where do the light-dependent reactions take place?',
  'What are the inputs of the Calvin cycle?',
  'What gas is released as a by-product of photosynthesis?',
  'How does photorespiration reduce crop yield?',
  'Why is the stroma important for the light-independent reactions?',
  'What is the overall balanced equation for photosynthesis?',
  'How do C4 plants avoid photorespiration?',
];

const FLASHCARD_CARDS = FLASHCARD_FRONTS.map((front, i) => ({
  id: `card_demo${i + 1}`,
  front,
  back: DEMO_BACKS[i],
  citations: [citation({ location: { page: 10 + i } })],
}));

const QUIZ_QUESTIONS = [
  {
    index: 0,
    text: 'Which pigment absorbs light energy for photosynthesis?',
    choices: choiceSet('Chlorophyll', 'Starch', 'Oxygen', 'Carbon dioxide'),
    citations: [citation()],
  },
  {
    index: 1,
    text: 'Where do the light-dependent reactions take place?',
    choices: choiceSet('Thylakoid membrane', 'Stroma', 'Outer membrane', 'Cytoplasm'),
    citations: [citation({ location: { page: 12 } })],
  },
  {
    index: 2,
    text: 'Which molecule is split to release oxygen during photosynthesis?',
    choices: choiceSet('Carbon dioxide', 'Glucose', 'Water', 'NADPH'),
    citations: [citation({ location: { page: 14 } })],
  },
  {
    index: 3,
    text: 'Which enzyme fixes carbon dioxide in the Calvin cycle?',
    choices: choiceSet('ATP synthase', 'Rubisco', 'Amylase', 'Helicase'),
    citations: [citation({ sourceId: 'src_demo02', type: 'pptx', title: 'lecture-04-cells.pptx', location: { slide: 11 }, excerpt: 'Rubisco catalyses the first step of carbon fixation, attaching CO₂ to ribulose bisphosphate.', score: 0.79 })],
  },
  {
    index: 4,
    text: 'What are the products of the light-dependent reactions used in the Calvin cycle?',
    choices: choiceSet('ATP and NADPH', 'Oxygen and water', 'Starch and sucrose', 'NADH and FADH₂'),
    citations: [citation({ location: { page: 15 } })],
  },
];

function choiceSet(correct, b, c, d) {
  const shuffled = [correct, b, c, d];
  const letters = ['a', 'b', 'c', 'd'];
  return shuffled.map((text, i) => ({ id: letters[i], text }));
}

// Index → the id of the correct choice. Deterministic grading in the fixture,
// exactly like the backend's string comparison against its stored key.
const QUIZ_KEY = ['Chlorophyll', 'Thylakoid membrane', 'Water', 'Rubisco', 'ATP and NADPH'];

const QUIZ_EXPLANATIONS = [
  'Chlorophyll is the pigment that absorbs light; the other options are products or unrelated molecules.',
  'The thylakoid membrane holds the photosystems; the Calvin cycle runs in the stroma.',
  'Water is split in photolysis, which is where the released oxygen comes from.',
  'Rubisco attaches CO₂ to RuBP — the first and rate-limiting step of the Calvin cycle.',
  'The light reactions export ATP and NADPH, which power carbon fixation in the stroma.',
];

function correctIdFor(question) {
  const right = QUIZ_KEY[question.index];
  return question.choices.find((choice) => choice.text === right).id;
}

const PROGRESS = {
  topics: [
    { topic: 'Photosynthesis', masteryPercent: 60, difficulty: 'medium', correct: 3, total: 5, needsRevision: false, lastPracticedAt: iso(-1) },
    { topic: 'Cell division', masteryPercent: 40, difficulty: 'easy', correct: 2, total: 5, needsRevision: true, lastPracticedAt: iso(-3) },
    { topic: 'Cell respiration', masteryPercent: 80, difficulty: 'hard', correct: 4, total: 5, needsRevision: false, lastPracticedAt: iso(-5) },
  ],
  overall: { quizzesTaken: 3, questionsAnswered: 15, accuracyPercent: 60 },
  suggestedNext: { topic: 'Cell division', difficulty: 'easy' },
  recentActivity: [
    { type: 'quiz', topic: 'Photosynthesis', detail: '3/5 correct (60%)', at: iso(-1) },
    { type: 'question', topic: null, detail: 'Asked: Where do the light-dependent reactions take place?', at: iso(-1) },
    { type: 'upload', topic: null, detail: 'biology-photosynthesis.pdf (14 pages)', at: iso(-2) },
    { type: 'quiz', topic: 'Cell division', detail: '2/5 correct (40%)', at: iso(-3) },
    { type: 'upload', topic: null, detail: 'lecture-04-cells.pptx (28 slides)', at: iso(-4) },
    { type: 'quiz', topic: 'Cell respiration', detail: '4/5 correct (80%)', at: iso(-5) },
  ],
};

/* --------------------------------------------------------- mock router */

const submittedQuizzes = new Map(); // quizId → stored result (409 on repeat)
const generatedQuizzes = new Map(); // quizId → { topic, questions }

export async function handleMock(path, { method = 'GET', body = {} } = {}) {
  await sleep(320);
  const route = `${method} ${path}`;

  if (route === 'GET /api/health') {
    return {
      status: 'ok',
      checks: {
        sqlite: { ok: true, message: '' },
        chroma: { ok: true, message: '' },
        nim: { ok: true, message: '', chatModel: 'nvidia/nemotron-3.5-lightning-30b-a3b', embeddingModel: 'nvidia/nemotron-3-embed-1b' },
      },
    };
  }

  if (route === 'GET /api/sources') return { sources: SOURCES };

  if (route === 'GET /api/learner/progress') return PROGRESS;

  if (route === 'POST /api/tutor/ask') {
    const question = (body.question || '').trim();
    if (question.length < 3 || question.length > 300) {
      throw httpError('VALIDATION_ERROR', 'Question must be between 3 and 300 characters.', 400);
    }
    const lower = question.toLowerCase();
    if (/mitosis|meiosis|chromosome/.test(lower)) return MITOSIS_ANSWER;
    if (/quantum|rocket|football|weather/.test(lower)) return ABSTAIN_ANSWER;
    return PHOTOSYNTHESIS_ANSWER;
  }

  if (route === 'POST /api/flashcards/generate') {
    const topic = (body.topic || '').trim();
    if (topic.length < 2 || topic.length > 80) {
      throw httpError('VALIDATION_ERROR', 'Topic must be between 2 and 80 characters.', 400);
    }
    const count = body.count ?? 8;
    if (count < 3 || count > 12) {
      throw httpError('VALIDATION_ERROR', 'Count must be between 3 and 12.', 400);
    }
    await sleep(500);
    return { topic, cards: FLASHCARD_CARDS.slice(0, count), model: 'nvidia/nemotron-3-super-120b-a12b' };
  }

  if (route === 'POST /api/quiz/generate') {
    const topic = (body.topic || '').trim();
    if (topic.length < 2 || topic.length > 80) {
      throw httpError('VALIDATION_ERROR', 'Topic must be between 2 and 80 characters.', 400);
    }
    const questionCount = body.questionCount ?? 5;
    if (questionCount < 3 || questionCount > 10) {
      throw httpError('VALIDATION_ERROR', 'questionCount must be between 3 and 10.', 400);
    }
    await sleep(600);
    const quizId = `quiz_demo${Math.random().toString(36).slice(2, 8)}`;
    const questions = QUIZ_QUESTIONS.slice(0, questionCount);
    generatedQuizzes.set(quizId, { topic, questions });
    return {
      quiz: { id: quizId, topic, difficulty: body.difficulty || 'medium', questions },
    };
  }

  const answerMatch = path.match(/^\/api\/quiz\/([^/]+)\/answer$/);
  if (route === `POST ${path}` && answerMatch) {
    const quizId = answerMatch[1];
    if (submittedQuizzes.has(quizId)) {
      const error = httpError('QUIZ_ALREADY_ANSWERED', 'This quiz was already submitted. Showing your stored result.', 409);
      error.data = {
        error: { code: 'QUIZ_ALREADY_ANSWERED', message: error.message },
        result: submittedQuizzes.get(quizId),
      };
      throw error;
    }
    const generated = generatedQuizzes.get(quizId);
    if (!generated) throw httpError('QUIZ_NOT_FOUND', 'That quiz does not exist.', 404);

    const answers = Array.isArray(body.answers) ? body.answers : [];
    const total = generated.questions.length;
    if (answers.length !== total || answers.some((a, i) => a.index !== i)) {
      throw httpError('VALIDATION_ERROR', 'Provide one answer per question, in order.', 400);
    }

    let correct = 0;
    const questions = generated.questions.map((question, index) => {
      const yourChoiceId = answers[index].choiceId ?? null;
      const correctChoiceId = correctIdFor(question);
      const isCorrect = yourChoiceId === correctChoiceId;
      if (isCorrect) correct += 1;
      return { index, yourChoiceId, correctChoiceId, correct: isCorrect, explanation: QUIZ_EXPLANATIONS[index], citations: question.citations };
    });

    const percent = Math.round((correct / total) * 100);
    const before = 0.6;
    const after = Math.min(1, Math.max(0, before + (percent - 50) / 200));
    const result = {
      score: { correct, total, percent },
      questions,
      masteryUpdate: { topic: generated.topic, before, after, delta: Number((after - before).toFixed(2)) },
      recommendedDifficulty: percent >= 80 ? 'hard' : percent >= 50 ? 'medium' : 'easy',
    };
    submittedQuizzes.set(quizId, result);
    return { result };
  }

  if (route === 'POST /api/sources/upload' || route === 'POST /api/sources/webpage') {
    throw httpError('VALIDATION_ERROR', 'Uploading materials is disabled in demo mode.', 400);
  }

  throw httpError('NOT_FOUND', `Demo mode has no fixture for ${method} ${path}.`, 404);
}
