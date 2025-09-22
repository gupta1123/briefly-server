import { generateEmbedding } from '../lib/embeddings.js';

// Folder-level multi-document QA: shortlist docs in scope, run per-doc QA, then synthesize
// Returns { answer, citations, considered }
export async function folderMultiDocQA({ app, db, orgId, question, allowedDocIds = [], maxDocs = 3, options = {} }) {
  // 1) Select top candidate docs within allowedDocIds via hybrid search
  let topDocIds = [];
  try {
    const { hybridSearch } = await import('../lib/metadata-embeddings.js');
    const searchResults = await hybridSearch(db, orgId, question, { limit: 20, threshold: 0.22 });
    const filtered = Array.isArray(searchResults)
      ? (allowedDocIds.length ? searchResults.filter(r => allowedDocIds.includes(r.doc_id)) : searchResults)
      : [];
    topDocIds = [...new Set(filtered.map(r => r.doc_id))].slice(0, Math.max(1, maxDocs));
  } catch {}
  if (topDocIds.length === 0 && allowedDocIds.length) {
    // Fallback: pick a few recent docs from the folder
    try {
      const { data: recent } = await db
        .from('documents')
        .select('id')
        .eq('org_id', orgId)
        .in('id', allowedDocIds)
        .order('uploaded_at', { ascending: false })
        .limit(maxDocs);
      topDocIds = (recent || []).map(r => r.id);
    } catch {}
  }
  if (topDocIds.length === 0) {
    return { answer: 'I could not find relevant documents in this folder.', citations: [], considered: { docIds: [], strategy: 'folder' } };
  }

  // 2) Fetch document details
  const { data: docDetails } = await db
    .from('documents')
    .select('id, title, filename, document_date, type, category')
    .eq('org_id', orgId)
    .in('id', topDocIds);
  const docMap = new Map((docDetails || []).map(d => [d.id, d]));

  // 3) For each doc, fetch top chunks and run per-doc QA (with MMR and coverage)
  const emb = await generateEmbedding(question).catch(() => null);
  const qaResults = [];
  function mmrSelect(list, k=6, lambda=0.7){
    const sel=[]; const usedIdx=new Set();
    const sim=(a,b)=>{ const ta=new Set(String(a.content||'').toLowerCase().split(/\s+/).slice(0,60)); const tb=new Set(String(b.content||'').toLowerCase().split(/\s+/).slice(0,60)); const inter=[...ta].filter(x=>tb.has(x)).length; return inter / Math.max(1, Math.max(ta.size,tb.size)); };
    const cand=[...list].sort((a,b)=>(b.similarity||0)-(a.similarity||0));
    while(sel.length<k && cand.length){ let best=null, bestScore=-1, bestIdx=-1; for(let i=0;i<cand.length;i++){ if(usedIdx.has(i)) continue; const rel=cand[i].similarity||0; const div = sel.length? Math.max(...sel.map(s=>sim(cand[i], s))) : 0; const mmr=lambda*rel - (1-lambda)*div; if(mmr>bestScore){ bestScore=mmr; best=cand[i]; bestIdx=i; } } if(best){ sel.push(best); usedIdx.add(bestIdx); } else break; }
    return sel;
  }
  for (const docId of topDocIds) {
    try {
      let topChunks = [];
      if (emb) {
        const { data: chunks } = await db.rpc('match_doc_chunks', {
          p_org_id: orgId,
          p_query_embedding: emb,
          p_match_count: 60,
          p_similarity_threshold: 0.22,
        });
        const pool = (chunks || [])
          .filter(c => c.doc_id === docId)
          .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
          .slice(0, 12);
        topChunks = mmrSelect(pool, 6, 0.7);
      }
      const doc = docMap.get(docId) || { id: docId, title: 'Document' };
      const { qaAboutDoc } = await import('./qa-doc.js');
      const { checkCoverage } = await import('../lib/coverage-checker.js');
      const out = await qaAboutDoc({ app, db, orgId, doc, question, topChunks });
      const snippets = topChunks.map(c=>({ content: c.content }));
      const cov = checkCoverage({ answer: out.answer, snippets, threshold: 0.15 });
      const avgSim = topChunks.length ? (topChunks.reduce((s,c)=>s+(c.similarity||0),0)/topChunks.length) : 0;
      qaResults.push({ docId, answer: out.answer || '', citations: Array.isArray(out.citations) ? out.citations : [], coverage: cov.coverageRatio, avgSim });
    } catch {}
  }

  // 4) Synthesize folder-level answer
  const withAnswers = qaResults.filter(r => r.answer && !/I don't have enough information/i.test(r.answer));
  const citations = withAnswers.flatMap(r => r.citations || []).slice(0, 6);
  const considered = { docIds: topDocIds, strategy: 'folder' };
  if (withAnswers.length === 0) {
    return { answer: 'I could not find the requested information in this folder.', citations: [], considered };
  }
  const strict = !!options?.strictCitations;
  if (withAnswers.length === 1) {
    const only = withAnswers[0];
    const coverage = typeof only.coverage === 'number' ? only.coverage : 0;
    const confidence = Math.max(0, Math.min(1, 0.5*coverage + 0.5*Math.min(1, only.avgSim||0)));
    if (strict && ((only.citations||[]).length === 0 || coverage < 0.5)) {
      const ask = 'To narrow this down, please specify a date range (e.g., 2021-01 to 2021-12), document type (e.g., inspection, invoice), or sender/receiver.';
      return { answer: `I don\'t have enough grounded evidence to answer precisely. ${ask}`, citations: [], considered, coverage, confidence };
    }
    return { answer: only.answer, citations: only.citations || citations, considered, coverage, confidence };
  }
  const bullet = withAnswers.map((r, i) => {
    const doc = docMap.get(r.docId);
    const name = doc?.title || doc?.filename || `Document ${i+1}`;
    return `- ${name}: ${r.answer}`;
  }).join('\n');
  const merged = `Here is what I found across top documents in this folder:\n\n${bullet}`;
  const avgCoverage = withAnswers.reduce((s,r)=>s+(typeof r.coverage==='number'?r.coverage:0),0)/withAnswers.length;
  const avgSim = withAnswers.reduce((s,r)=>s+(typeof r.avgSim==='number'?r.avgSim:0),0)/withAnswers.length;
  const confidence = Math.max(0, Math.min(1, 0.5*avgCoverage + 0.5*Math.min(1, avgSim)));
  if (strict && (citations.length === 0 || avgCoverage < 0.5)) {
    const ask = 'To narrow this down, please specify a date range (e.g., 2021-01 to 2021-12), document type (e.g., inspection, invoice), or sender/receiver.';
    return { answer: `I don\'t have enough grounded evidence to answer precisely. ${ask}`, citations: [], considered, coverage: avgCoverage, confidence };
  }
  return { answer: merged, citations, considered, coverage: avgCoverage, confidence };
}

export default { folderMultiDocQA };
