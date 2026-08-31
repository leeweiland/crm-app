// Shared cosine-similarity retrieval over any embeddings cache file built with
// the same {chunks:[{text,embedding,...}]} shape as chunks_cache.json /
// sales_convos_cache.json. Two separate cache files, one retrieval function.
import { readFileSync, existsSync } from "fs";

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMS = 512;

const cacheMemo = new Map();

function loadCache(cachePath) {
  if (!cacheMemo.has(cachePath)) {
    if (!existsSync(cachePath)) throw new Error(`cache not found: ${cachePath}`);
    cacheMemo.set(cachePath, JSON.parse(readFileSync(cachePath, "utf8")));
  }
  return cacheMemo.get(cachePath);
}

// Call after overwriting a cache file on disk (e.g. the daily sync job) so
// the next retrieveFromCache() call re-reads the fresh file instead of
// serving the in-memory copy for the rest of the process's lifetime.
export function invalidateCache(cachePath) {
  cacheMemo.delete(cachePath);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function embedQuery(query) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: query, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new Error(`OpenAI embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

export async function retrieveFromCache(cachePath, query, { topN = 8 } = {}) {
  const cache = loadCache(cachePath);
  const chunks = cache.chunks || [];
  const queryVec = await embedQuery(query);
  return chunks
    .map((c) => ({ ...c, score: cosineSimilarity(queryVec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(({ embedding: _e, ...rest }) => rest);
}

export function formatChunksForPrompt(chunks, label) {
  const body = chunks
    .map((c) => {
      if (c.type === "sale_conversation") {
        return `--- ${c.source} ---\n${c.text}`;
      }
      if (c.type === "campaign") {
        const perf = [
          c.open_rate != null ? `open: ${c.open_rate}%` : null,
          c.ctr != null ? `CTR: ${c.ctr}%` : null,
        ].filter(Boolean).join(", ");
        return `--- EMAIL: "${c.source}"${perf ? ` [${perf}]` : ""} ---\n${c.text}`;
      }
      return `--- DOC: ${c.source} ---\n${c.text}`;
    })
    .join("\n\n");
  return `\n\n### ${label}\n${body}`;
}
