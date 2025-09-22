// Task Controller: deterministic policy that selects task based on structured context
// This sits above the LLM router. The router is advisory only.

export const Tasks = Object.freeze({
  SummarizeDoc: 'SummarizeDoc',
  QAAboutDoc: 'QAAboutDoc',
  MetadataQA: 'MetadataQA',
  LinkedContext: 'LinkedContext',
});

/**
 * Decide task based on scope + question + simple signals
 * @param {Object} ctx { scope, docId, includeLinked, includeVersions }
 * @param {string} question
 * @param {Object} options { hasSummary?: boolean }
 */
export function decideTask(ctx, question, options = {}) {
  const scope = (ctx?.scope || 'org');
  const q = String(question || '').trim();
  const m = q.toLowerCase();

  const isMetadataQuestion = () => {
    // Direct keywords
    const keywords = ['title','subject','sender','receiver','date','category','type','filename','file name','document type'];
    if (keywords.some(k => m.includes(k))) return true;
    // Common phrasing / synonyms
    const re = [
      /who\s+(is\s+)?(the\s+)?sender\b/i,
      /who\s+sent\b/i,
      /from:\s*/i,
      /to:\s*/i,
      /to\s+whom\b/i,
      /recipient\b/i,
      /addressee\b/i,
      /what\s+is\s+(the\s+)?(document\s+)?(type|category)\b/i,
      /what\s+is\s+(the\s+)?file\s*name\b/i,
    ];
    return re.some(r => r.test(q));
  };

  // Doc scope: never "find"; only summarize or QA about the given doc
  if (scope === 'doc') {
    // If question hints strongly at metadata fields, prefer MetadataQA
    // Linked / versions intent
    if (ctx?.includeLinked || /(\blink(ed)?\b|\brelated\b|\bversions?\b)/.test(m)) {
      return { task: Tasks.LinkedContext };
    }
    if (isMetadataQuestion()) {
      return { task: Tasks.MetadataQA };
    }
    // If the question is vague/"about"/"what is it" or empty → summarize
    const aboutHints = ['what is it about', 'what is this doc about', 'what is this about', 'about this doc', 'overview', 'summary'];
    if (!q || aboutHints.some((h) => m.includes(h))) {
      return { task: Tasks.SummarizeDoc };
    }
    // Default QA on doc
    return { task: Tasks.QAAboutDoc };
  }

  // Folder scope: prefer QA about docs within folder; router optional
  if (scope === 'folder') {
    if (isMetadataQuestion()) return { task: Tasks.MetadataQA };
    const aboutHints = ['overview', 'about', 'summary'];
    if (!q || aboutHints.some((h) => m.includes(h))) return { task: Tasks.SummarizeDoc };
    return { task: Tasks.QAAboutDoc };
  }

  // Other scopes: leave to existing flow for now; could expand later
  return { task: null };
}
