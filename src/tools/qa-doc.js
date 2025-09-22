import { generateText } from '../lib/ai-service.js';

/**
 * Answer a user question about a single document using top chunks
 * @param {Object} params { app, db, orgId, doc, question, topChunks }
 * Returns { answer, citations }
 */
export async function qaAboutDoc({ app, db, orgId, doc, question, topChunks }) {
  let citations = [];
  try {
    const top = (topChunks || []).slice(0, 3);
    citations = top.map(c => ({ docId: doc.id, docName: doc.title || doc.name || 'Document', snippet: String(c.content || '').slice(0, 500), page: typeof c.page === 'number' ? c.page : null }));
  } catch {}

  let answerText = '';
  try {
    const context = (topChunks || []).map((c, i) => `Snippet ${i + 1}: ${String(c.content || '').slice(0, 800)}`).join('\n\n');
    const gen = await generateText({
      prompt: `You are a precise QA assistant. Answer the user's question using ONLY the provided document snippets.

Special Instructions for Numerical Queries:
- If the question asks about values, amounts, totals, or currency (₹, Rs.), look for EXACT numerical matches
- Extract specific numbers with their context, not just semantic similarity
- When you find currency values, include the exact amount in your answer
- For "total value" questions, look for lines with "total", "amount", "value", "worth"

Formatting requirements:
- Respond in GitHub-Flavored Markdown (GFM).
- Use concise bullet points and short paragraphs.
- When listing rows/values, use a Markdown table with clear headers.
- If you find specific numerical values, state them clearly in the format "The [what] was [value]"

If the snippets do not contain the answer, say exactly: "I don't have enough information in this document to answer that."

Question: ${question}

Snippets:
${context}`,
      temperature: 0.2,
    });
    answerText = String(gen?.text || '').trim();
  } catch {
    // Degraded path: return best excerpts instead of claiming insufficient info when LLM unavailable
    const lines = (topChunks || []).slice(0, 3).map((c, i) => `(${i + 1}) ${String(c.content || '').slice(0, 240)}`);
    if (lines.length) {
      answerText = `Relevant excerpts from the document (AI temporarily unavailable):\n\n${lines.join('\n\n')}`;
    }
  }
  if (!answerText) {
    answerText = "I don't have enough information in this document to answer that.";
  }
  // Enforce minimal grounding: if no citations, prefer an explicit insufficient message
  if ((!Array.isArray(citations) || citations.length === 0) && !/I don't have enough information/i.test(answerText)) {
    answerText = "I don't have enough information in this document to answer that.";
  }
  return { answer: answerText, citations };
}
