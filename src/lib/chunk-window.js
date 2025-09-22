// Build a windowed set of chunks around anchor pages for a doc.
// Uses page adjacency rather than chunk_index to avoid schema coupling.

export async function buildWindowedChunks({ db, orgId, docId, anchorChunks, windowPages = 1, maxPerPage = 10 }) {
  try {
    const pages = Array.from(new Set((anchorChunks || []).map(c => typeof c.page === 'number' ? c.page : null).filter(p => p !== null)));
    if (pages.length === 0) return anchorChunks || [];
    const pageSet = new Set();
    for (const p of pages) {
      for (let d = -windowPages; d <= windowPages; d++) pageSet.add(p + d);
    }
    const pageList = Array.from(pageSet).filter(p => typeof p === 'number');
    if (pageList.length === 0) return anchorChunks || [];
    const { data: rows } = await db
      .from('doc_chunks')
      .select('doc_id, content, page')
      .eq('org_id', orgId)
      .eq('doc_id', docId)
      .in('page', pageList)
      .limit(pageList.length * maxPerPage);
    const combined = [...(anchorChunks || [])];
    const seen = new Set(combined.map(c => String(c.content||'').slice(0,200)));
    for (const r of rows || []) {
      const key = String(r.content||'').slice(0,200);
      if (!seen.has(key)) { combined.push({ ...r, similarity: 0.2 }); seen.add(key); }
    }
    return combined;
  } catch {
    return anchorChunks || [];
  }
}

export default { buildWindowedChunks };

