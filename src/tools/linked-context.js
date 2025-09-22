import { generateEmbedding } from '../lib/embeddings.js';

/**
 * LinkedContext: answer questions leveraging the focus doc + versions + linked docs
 * @param {Object} params { app, db, orgId, docId, question, includeVersions?: boolean, includeLinked?: boolean }
 * Returns { answer, citations }
 */
export async function linkedContext({ app, db, orgId, docId, question, includeVersions = true, includeLinked = true }) {
  const allowed = new Set([docId]);

  // include versions
  if (includeVersions) {
    try {
      const { data: one } = await db.from('documents').select('version_group_id').eq('org_id', orgId).eq('id', docId).maybeSingle();
      const vg = one?.version_group_id;
      if (vg) {
        const { data: vs } = await db.from('documents').select('id').eq('org_id', orgId).eq('version_group_id', vg);
        (vs || []).forEach(r => r?.id && allowed.add(r.id));
      }
    } catch {}
  }
  // include linked
  if (includeLinked) {
    try {
      const { data: out } = await db.from('document_links').select('linked_doc_id').eq('org_id', orgId).eq('doc_id', docId);
      const { data: inc } = await db.from('document_links').select('doc_id').eq('org_id', orgId).eq('linked_doc_id', docId);
      (out || []).forEach(r => r?.linked_doc_id && allowed.add(r.linked_doc_id));
      (inc || []).forEach(r => r?.doc_id && allowed.add(r.doc_id));
    } catch {}
  }

  const ids = Array.from(allowed);
  if (ids.length === 0) return { answer: 'No related documents found.', citations: [] };

  const { data: docs } = await db
    .from('documents')
    .select('id, title, filename, subject, sender, receiver, document_date, category, type')
    .eq('org_id', orgId)
    .in('id', ids);

  const titleOf = (id) => {
    const d = (docs || []).find(x => x.id === id);
    return d ? (d.title || d.filename || 'Document') : 'Document';
  };

  const q = String(question || '').toLowerCase();
  const listOnly = /(\blink(ed)?\b|\brelated\b|\bversions?\b|\blist\b|\bshow\b)/.test(q) && !/why|how|compare|difference|explain/i.test(q);

  if (listOnly) {
    // Produce a concise list of related docs with basic attributes
    const lines = (docs || [])
      .filter(d => d.id !== docId)
      .slice(0, 10)
      .map(d => `• ${d.title || d.filename || 'Document'}${d.document_date ? ` — ${d.document_date}` : ''}${d.category ? ` — ${d.category}` : ''}`);
    const answer = lines.length ? `Related documents:\n\n${lines.join('\n')}` : 'No related documents found.';
    const citations = [{ docId, docName: titleOf(docId), snippet: 'Linked/Versions overview' }];
    return { answer, citations };
  }

  // QA across related set using hybrid search + chunk matches
  let citations = [];
  let answer = '';
  try {
    const emb = await generateEmbedding(question);
    if (emb) {
      const { data: chunks } = await db.rpc('match_doc_chunks', {
        p_org_id: orgId,
        p_query_embedding: emb,
        p_match_count: 200,
        p_similarity_threshold: 0.15,
      });
      const pool = (chunks || []).filter(c => allowed.has(c.doc_id))
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
        .slice(0, 10);
      const context = pool.map((c, i) => `(${i + 1}) [${titleOf(c.doc_id)}] ${String(c.content || '').slice(0, 700)}`).join('\n\n');
      // Compose answer using generation with citations
      const { generateText } = await import('../lib/ai-service.js');
      const gen = await generateText({
        prompt: `Answer the user's question using ONLY the provided snippets from the related documents. Cite the document name inline in your wording if appropriate. If there is not enough information, say so concisely.\n\nQuestion: ${question}\n\nSnippets:\n${context}`,
        temperature: 0.25,
      });
      answer = String(gen?.text || '').trim();
      citations = pool.slice(0, 5).map(c => ({ docId: c.doc_id, docName: titleOf(c.doc_id), snippet: String(c.content || '').slice(0, 500) }));
    }
  } catch {}
  if (!answer) answer = 'I could not find enough information in the related documents to answer that.';
  return { answer, citations };
}
