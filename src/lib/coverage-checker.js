/**
 * Lightweight coverage checker: ensures answer claims are supported by retrieved snippets.
 * Strategy: split answer into sentences; for each sentence, compute token-overlap with each snippet.
 * If max overlap >= threshold (e.g., 0.15) consider the claim covered.
 */

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function sentenceSplit(answer) {
  const parts = String(answer || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(answer || '').trim()].filter(Boolean);
}

function overlapScore(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  // Jaccard-like score (lighter): intersection over max size to be conservative
  return inter / Math.max(setA.size, setB.size);
}

export function checkCoverage({ answer, snippets, threshold = 0.15 }) {
  const sents = sentenceSplit(answer);
  const snipTokens = (Array.isArray(snippets) ? snippets : [])
    .map((s) => tokenize(typeof s === 'string' ? s : (s?.content || s?.snippet || '')));
  let covered = 0;
  const details = [];
  for (const sent of sents) {
    const st = tokenize(sent);
    let best = 0;
    for (const tok of snipTokens) {
      const sc = overlapScore(st, tok);
      if (sc > best) best = sc;
      if (best >= threshold) break;
    }
    if (best >= threshold) covered++;
    details.push({ sentence: sent, score: best });
  }
  const ratio = sents.length ? covered / sents.length : 0;
  return { coverageRatio: ratio, details };
}

export default { checkCoverage };

