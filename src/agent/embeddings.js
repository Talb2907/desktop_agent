// Lazy-loaded embedding pipeline — model is downloaded on first use (~22 MB)
// Uses Xenova/all-MiniLM-L6-v2: 384-dim, fast, works well for Hebrew + English

let _pipeline = null;
let _loadPromise = null;

async function getEmbedder() {
  if (_pipeline) return _pipeline;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    return _pipeline;
  })();

  return _loadPromise;
}

async function embed(text) {
  const embedder = await getEmbedder();
  const output = await embedder(String(text).slice(0, 512), { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

// Embeddings are L2-normalized, so cosine similarity = dot product
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Embed a query and rank candidates by cosine similarity.
 * Each candidate must have an `embedding` (Float32Array) property.
 * Returns top-k candidates above minScore, sorted descending.
 */
async function searchSimilar(queryText, candidates, { topK = 5, minScore = 0.4 } = {}) {
  if (candidates.length === 0) return [];
  const queryEmb = await embed(queryText);
  return candidates
    .map((c) => ({ ...c, score: cosineSimilarity(queryEmb, c.embedding) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { embed, cosineSimilarity, searchSimilar };
