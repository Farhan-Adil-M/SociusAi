// Shared fixtures for HTTP-API tests: a stubbed AI provider and an in-memory
// stand-in for ChromaDB, so the whole loop can be exercised without network.

export const EMBEDDING = Array(2048).fill(0.5);
export const TUTOR_ANSWER = 'Mitosis produces two identical daughter cells [1].';
export const QUIZ_JSON = JSON.stringify({
  questions: [
    { question: 'Which process produces two identical cells?', choices: ['Mitosis', 'Meiosis', 'Fusion', 'Diffusion'], answer: 'Mitosis', explanation: 'Mitosis copies the nucleus once.', cite: [1, 2] },
    { question: 'How many divisions does meiosis involve?', choices: ['One', 'Two', 'Three', 'None'], answer: 'Two', explanation: 'Meiosis divides twice.', cite: [2] },
    { question: 'Where does mitosis occur in the cell?', choices: ['Nucleus', 'Ribosome', 'Membrane', 'Vacuole'], answer: 'Nucleus', explanation: 'The nucleus divides.', cite: [1] },
  ],
});
export const FLASHCARD_JSON = JSON.stringify({
  cards: [
    { front: 'What does mitosis produce?', back: 'Two genetically identical daughter cells.', cite: [1] },
    { front: 'How many cells does meiosis produce?', back: 'Four.Cells each with half the chromosome number.', cite: [2] },
    { front: 'What happens during DNA replication?', back: 'The cell copies its entire genome before dividing.', cite: [3] },
  ],
});

/** In-memory stand-in for ChromaDB with the same interface we use. */
export function fakeVector() {
  const store = [];
  return {
    store,
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      ids.forEach((id, i) => store.push({ id, embedding: embeddings[i], text: documents[i], metadata: metadatas[i] }));
    },
    queryChunks: async ({ nResults = 6, sourceIds = [] }) => {
      const pool = sourceIds.length ? store.filter((s) => sourceIds.includes(s.metadata.sourceId)) : store;
      return pool.slice(0, nResults).map((s) => ({ ...s, distance: 0.2 }));
    },
    pingChroma: async () => true,
    resetCollection: async () => { store.length = 0; },
  };
}

export function makeAi(overrides = {}) {
  const calls = [];
  return {
    calls,
    embedTexts: async (texts) => texts.map(() => EMBEDDING),
    embedQuery: async () => EMBEDDING,
    chatCompletion: async (messages) => {
      calls.push(messages);
      const system = messages[0].content;
      if (system.includes('flashcards')) return FLASHCARD_JSON;
      if (system.includes('multiple-choice')) return QUIZ_JSON;
      if (system.includes('organise') || system.includes('study sessions')) {
        return JSON.stringify({
          matchSessionId: null,
          newSession: { category: 'subject', title: 'Biology', subject: 'cell biology', tags: ['cells'] },
          confidence: 'high',
          reason: 'material matches biology',
        });
      }
      return TUTOR_ANSWER;
    },
    ...overrides,
  };
}
