import { generateEmbedding } from '../lib/embeddings.js';

/**
 * FolderSearch: answer a question over a folder subtree by selecting top docs and running doc QA/summarize
 * @param {Object} params { app, db, orgId, folderPath, question, allowedDocIds: Set<string> }
 * Returns { answer, citations }
 */
export async function folderSearch({ app, db, orgId, folderPath = [], question, allowedDocIds = new Set() }) {
  // Generate query embedding once
  const emb = await generateEmbedding(question);

  // Get candidate docs from subtree (allowedDocIds expected from caller)
  const candidateIds = Array.from(allowedDocIds);
  if (candidateIds.length === 0) {
    return { answer: 'No documents found in this folder.', citations: [] };
  }

  // Rank candidates via hybrid search then restrict to subtree
  let ranked = [];
  try {
    const { hybridSearch } = await import('../lib/metadata-embeddings.js');
    const res = await hybridSearch(db, orgId, question, { limit: 10, threshold: 0.5 });
    ranked = (res || []).filter(r => allowedDocIds.has(r.doc_id));
  } catch {
    ranked = [];
  }

  // If no semantic ranking, fall back to recent docs in subtree
  let topIds = ranked.length ? [...new Set(ranked.map(r => r.doc_id))].slice(0, 5) : candidateIds.slice(0, 5);

  // Fetch doc metadata
  const { data: docRows } = await db
    .from('documents')
    .select('id, title, filename, subject, sender, receiver, document_date, category, type')
    .eq('org_id', orgId)
    .in('id', topIds);
  const docs = (docRows || []).filter(d => d.type !== 'folder');

  // Prepare top chunks per doc
  const perDocChunks = new Map();
  if (emb) {
    try {
      const { data: chunks } = await db.rpc('match_doc_chunks', {
        p_org_id: orgId,
        p_query_embedding: emb,
        p_match_count: 200,
        p_similarity_threshold: 0.15,
      });
      for (const d of docs) {
        const list = (chunks || []).filter(c => c.doc_id === d.id)
          .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
          .slice(0, 6);
        perDocChunks.set(d.id, list);
      }
    } catch {}
  }

  // Decide if this is an overview ask → summarize top doc; else QA across top few and merge
  const lower = String(question || '').toLowerCase();
  const wantOverview = /\boverview\b|\bsummary\b|\babout\b/.test(lower);

  let answers = [];
  for (const d of docs) {
    const topChunks = perDocChunks.get(d.id) || [];
    try {
      if (wantOverview) {
        const { summarizeDoc } = await import('./summarize-doc.js');
        const res = await summarizeDoc({ app, db, orgId, doc: { id: d.id, title: d.title || d.filename }, contentText: topChunks.map(c => c.content).join('\n---\n'), topChunks });
        answers.push({ docId: d.id, title: d.title || d.filename || 'Document', ...res });
      } else {
        const { qaAboutDoc } = await import('./qa-doc.js');
        const res = await qaAboutDoc({ app, db, orgId, doc: { id: d.id, title: d.title || d.filename }, question, topChunks });
        answers.push({ docId: d.id, title: d.title || d.filename || 'Document', ...res });
      }
    } catch {}
    if (answers.length >= 3) break;
  }

  if (answers.length === 0) return { answer: 'No relevant information found in this folder.', citations: [] };

  // Merge answers into a concise response
  const merged = answers.map((a, i) => `(${i + 1}) ${a.title}: ${a.answer}`).join('\n\n');
  const citations = answers.flatMap(a => a.citations || []).slice(0, 8);
  return { answer: merged, citations };
}

