import { safeLLMCall, definePrompt, canMakeRequest } from './ai-service.js';
import { z } from 'zod';

// Lightweight LLM reranker. Scores each candidate 0..1 and returns sorted list.
const rerankPrompt = definePrompt({
  name: 'rerankCandidates',
  input: {
    schema: z.object({
      question: z.string(),
      entities: z.array(z.object({ type: z.string(), value: z.string(), confidence: z.number().optional() })).optional(),
      candidates: z.array(z.object({
        id: z.string(),
        title: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        snippet: z.string().nullable().optional(),
        type: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
      }))
    })
  },
  output: {
    schema: z.object({
      scores: z.array(z.object({ id: z.string(), score: z.number().min(0).max(1) }))
    })
  },
  prompt: `You are a precise reranker. Score each candidate from 0 to 1 for how relevant it is to the user's question, 
considering entities and whether the snippet looks like the requested document type. Prefer candidates that clearly match 
the requested type (e.g., inspection report) and contain on-topic terms. Penalize generic or off-topic snippets.

Return ONLY JSON: { "scores": [{"id":"...","score":0.92}, ...] }

Question: {{{question}}}
Entities: {{{entities}}}
Candidates:
{{#each candidates}}
- id: {{{id}}}
  title: {{{title}}}
  name: {{{name}}}
  type: {{{type}}}
  category: {{{category}}}
  snippet: {{{snippet}}}
{{/each}}
`
});

export async function rerankCandidates(question, entities, docs, topK = 5) {
  if (!Array.isArray(docs) || docs.length === 0) return [];
  const key = buildCacheKey(question, docs);
  const cached = getCache(key);
  if (cached) return cached.slice(0, topK);

  // Light vector/lexical fallback rerank for small sets or when provider is backed off
  const wantLLM = docs.length > 7 && canMakeRequest();
  let ranked;
  if (wantLLM) {
    try {
      const candidates = docs.map(d => ({
        id: d.id,
        title: d.title || null,
        name: d.name || null,
        snippet: d.content ? String(d.content).slice(0, 500) : null,
        type: d.documentType || null,
        category: d.category || null,
      })).slice(0, 10);
      const res = await safeLLMCall(() => rerankPrompt({ question, entities: entities || [], candidates }), { maxRetries: 2 });
      const scoreMap = new Map((res?.scores || []).map(s => [s.id, s.score]));
      ranked = docs
        .map(d => ({ d, score: scoreMap.has(d.id) ? scoreMap.get(d.id) : 0 }))
        .sort((a, b) => b.score - a.score)
        .map(s => s.d);
    } catch {
      ranked = vectorFallbackRerank(question, docs);
    }
  } else {
    ranked = vectorFallbackRerank(question, docs);
  }
  setCache(key, ranked, 60_000);
  return ranked.slice(0, topK);
}

export default { rerankCandidates };

// --- Simple cache ---
const cache = new Map();
function buildCacheKey(question, docs){
  const ids = docs.map(d=>d.id).join(',');
  return `${question}::${ids}`;
}
function getCache(key){
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(key); return null; }
  return v.data;
}
function setCache(key, data, ttlMs){ cache.set(key, { data, exp: Date.now()+ttlMs }); }

// --- Vector/lexical fallback reranker ---
function vectorFallbackRerank(question, docs){
  const q = String(question||'').toLowerCase();
  const qTerms = q.split(/\s+/).filter(Boolean);
  const scoreDoc = (d) => {
    const title = String(d.title||d.name||'').toLowerCase();
    const type = String(d.documentType||d.type||'').toLowerCase();
    const cat = String(d.category||'').toLowerCase();
    const snippet = String(d.content||'').toLowerCase();
    let s = 0;
    for(const t of qTerms){
      if (!t) continue;
      if (title.includes(t)) s += 2.0;
      if (type.includes(t) || cat.includes(t)) s += 1.0;
      if (snippet.includes(t)) s += 0.5;
    }
    // prefer longer snippets a bit, to avoid empty-content docs
    s += Math.min(1.0, (d.content||'').length / 2000);
    return s;
  };
  return docs
    .map(d=>({ d, s: scoreDoc(d) }))
    .sort((a,b)=> b.s - a.s)
    .map(x=>x.d);
}
