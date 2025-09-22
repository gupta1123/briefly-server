import { generateText } from '../lib/ai-service.js';

/**
 * Summarize a single document using prepared content
 * @param {Object} params { app, db, orgId, doc, contentText, topChunks }
 * Returns { answer, citations }
 */
export async function summarizeDoc({ app, db, orgId, doc, contentText, topChunks }) {
  let citations = [];
  try {
    const top = (topChunks || []).slice(0, 3);
    citations = top.map(c => ({ docId: doc.id, docName: doc.title || doc.name || 'Document', snippet: String(c.content || '').slice(0, 500) }));
  } catch {}

  let answerText = '';
  try {
    const maxLen = 9000;
    const input = String(contentText || '').slice(0, maxLen);
    const gen = await generateText({
      prompt: `You are a precise summarizer. Summarize the document below in 3–6 sentences. Focus on what it is about, key facts, parties, dates, locations, amounts, and outcomes. Do not say you analyzed documents; write the summary directly.\n\nDocument:\n\n${input}`,
      temperature: 0.3,
    });
    answerText = String(gen?.text || '').trim();
  } catch {}
  if (!answerText) {
    const firstLines = String(contentText || '').split(/\n+/).filter(Boolean).slice(0, 4).join(' ');
    answerText = firstLines || 'Summary not available.';
  }
  return { answer: answerText, citations };
}

