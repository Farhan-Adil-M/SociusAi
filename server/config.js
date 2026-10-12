// Central configuration. Reads environment variables once. Essential values
// are checked by assertConfig() at server startup (not at import time, so
// unit tests can run without a filled-in .env).

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export function assertConfig() {
  const missing = [];
  if (!config.nimApiKey) missing.push('NIM_API_KEY');
  if (missing.length > 0) {
    console.error(`\nMissing environment variable(s): ${missing.join(', ')}.\nCopy .env.example to .env and fill in real values.\n`);
    process.exit(1);
  }
}

export const config = {
  port: Number(optional('PORT', 3000)),
  maxUploadMb: Number(optional('MAX_UPLOAD_MB', 25)),

  // NVIDIA NIM — every value verified against our account (see docs/API_CONTRACT.md).
  nimApiKey: optional('NIM_API_KEY', ''),
  nimBaseUrl: optional('NIM_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
  nimEmbedModel: optional('NIM_EMBED_MODEL', 'nvidia/nemotron-3-embed-1b'),
  nimChatModel: optional('NIM_CHAT_MODEL', 'nvidia/nemotron-3.5-lightning-30b-a3b'),
  nimAssessModel: optional('NIM_ASSESS_MODEL', 'nvidia/nemotron-3-super-120b-a12b'),
  nimTimeoutMs: Number(optional('NIM_TIMEOUT_MS', 45000)),

  // ChromaDB — Cloud when CHROMA_API_KEY is set, otherwise the local server.
  chromaApiKey: optional('CHROMA_API_KEY', ''),
  chromaTenant: optional('CHROMA_TENANT', ''),
  chromaDatabase: optional('CHROMA_DATABASE', ''),
  chromaCollection: optional('CHROMA_COLLECTION', 'socius_chunks'),
  chromaLocalHost: optional('CHROMA_LOCAL_HOST', 'localhost'),
  chromaLocalPort: Number(optional('CHROMA_LOCAL_PORT', 8100)),

  dataDir: optional('DATA_DIR', 'data'),
};
