import { generateEmbedding } from '../lib/embeddings.js';

// Helper: numeric extraction from chunks around key terms
function wordToNum(w){
  const m = {
    one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20
  };
  return m[String(w||'').toLowerCase()] ?? null;
}
function extractNumericFromText(txt){
  const patterns = [
    /(\d+)\s+(?:accused|individuals?|persons?|people)/i,
    /(?:accused|individuals?|persons?|people)\s+(?:were|was|are|is)?\s*(\d+)/i,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b\s+(?:accused|individuals?|persons?|people)/i
  ];
  for (const re of patterns){
    const m = String(txt||'').match(re);
    if (m && m[1]) { const n = Number(m[1]); if (!isNaN(n)) return n; const w = wordToNum(m[1]); if (w!==null) return w; }
  }
  return null;
}

async function metadataSearch(db, orgId, filters = {}, opts = {}){
  let q = db.from('documents').select('id, title, filename, subject, sender, receiver, document_date, category, type').eq('org_id', orgId).neq('type','folder');
  if (filters.sender) q = q.ilike('sender', `%${filters.sender}%`);
  if (filters.receiver) q = q.ilike('receiver', `%${filters.receiver}%`);
  if (filters.category) q = q.ilike('category', `%${filters.category}%`);
  if (filters.type) q = q.ilike('type', `%${filters.type}%`);
  if (filters.dateStart) q = q.gte('document_date', filters.dateStart);
  if (filters.dateEnd) q = q.lte('document_date', filters.dateEnd);
  if (Array.isArray(filters.allowedDocIds) && filters.allowedDocIds.length) q = q.in('id', filters.allowedDocIds);
  if (opts.limit) q = q.limit(opts.limit);
  const { data } = await q;
  return data || [];
}

async function vectorSearch(db, orgId, question, docIds, opts = {}){
  const emb = await generateEmbedding(question).catch(()=>null);
  if (!emb) return [];
  const { data: rows } = await db.rpc('match_doc_chunks', {
    p_org_id: orgId,
    p_query_embedding: emb,
    p_match_count: opts.matchCount || 100,
    p_similarity_threshold: opts.threshold ?? 0.3,
  });
  const set = new Set(docIds);
  return (rows || []).filter(r => set.size===0 || set.has(r.doc_id));
}

export async function executePlan({ app, db, orgId, question, conversation = [], memory = {}, context = {}, decision, allowedDocIds = [], options = {} }){
  const scope = context?.scope || 'org';
  const allowed = Array.isArray(allowedDocIds) ? allowedDocIds : [];
  const mdAnswer = (title, lines=[]) => lines.length ? `### ${title}\n\n${lines.join('\n')}` : `### ${title}`;
  const activeFilters = Object.assign({}, (memory?.filters||{}), (options?.filters||{}));
  const normFilters = {
    sender: activeFilters.sender || undefined,
    receiver: activeFilters.receiver || undefined,
    category: activeFilters.category || undefined,
    type: activeFilters.docType || activeFilters.type || undefined,
  };

  switch (decision.intent) {
    case 'ListDocs': {
      const docs = await metadataSearch(db, orgId, { ...normFilters, allowedDocIds: allowed }, { limit: 20 });
      const lines = (docs||[]).slice(0,10).map(d => {
        const name = d.title || d.filename || 'Document';
        const parts = [name]; if (d.document_date) parts.push(d.document_date); if (d.type) parts.push(d.type); if (d.category) parts.push(d.category); if (d.sender) parts.push(d.sender);
        return `- ${parts.join(' — ')}`;
      });
      return { answer: mdAnswer('Top results', lines), citations: [], considered: { docIds: (docs||[]).map(d=>d.id), strategy: scope } };
    }
    case 'FolderQA': {
      const allowed = Array.isArray(allowedDocIds) ? allowedDocIds : [];
      const { folderMultiDocQA } = await import('../tools/folder-qa.js');
      const out = await folderMultiDocQA({ app, db, orgId, question, allowedDocIds: allowed, maxDocs: 3, options });
      return { answer: out.answer, citations: out.citations || [], considered: out.considered || { docIds: allowed, strategy: 'folder' }, coverage: out.coverage, confidence: out.confidence };
    }
    case 'DocCount': {
      const count = allowed.length;
      return { answer: mdAnswer('Folder Summary', [`- Total documents: **${count}**`]), citations: [], considered: { docIds: allowed, strategy: scope } };
    }
    case 'FieldExtract': {
      // Load chunks via vector search (or lexical fallback)
      let chunks = [];
      try { chunks = await vectorSearch(db, orgId, question, allowed, { matchCount: 120, threshold: 0.3 }); } catch {}
      if (chunks.length === 0 && allowed.length) {
        try {
          const { data: rows } = await db
            .from('doc_chunks').select('doc_id, content, page')
            .eq('org_id', orgId).in('doc_id', allowed)
            .ilike('content', `%${(String(question).split(/\s+/)[0]||'').slice(0,20)}%`).limit(200);
          chunks = rows || [];
        } catch {}
      }
      const lowerQ = String(question||'').toLowerCase();
      // Numeric counts (e.g., individuals accused)
      if (/\b(how many|number of|count of)\b/.test(lowerQ)) {
        let found = null; let foundChunk = null;
        for (const ch of chunks) { const n = extractNumericFromText(ch.content); if (n!==null){ found=n; foundChunk=ch; break; } }
        if (found !== null) {
          const answer = mdAnswer('Answer', [`- Individuals accused: **${found}**`]);
          const citations = foundChunk ? [{ docId: foundChunk.doc_id, docName: 'Document', snippet: String(foundChunk.content||'').slice(0,300), page: typeof foundChunk.page==='number'?foundChunk.page:null }] : [];
          return { answer, citations, considered: { docIds: Array.from(new Set(chunks.map(c=>c.doc_id))), strategy: scope } };
        }
        // Additional lexical sweep focused on accused patterns (English + Marathi)
        try {
          const { data: rows2 } = await db
            .from('doc_chunks').select('doc_id, content, page')
            .eq('org_id', orgId).in('doc_id', allowed)
            .or('content.ilike.%accused%,content.ilike.%individuals%,content.ilike.%persons%,content.ilike.%people%,content.ilike.%आरोपी%');
          for (const ch of rows2 || []) {
            const n = extractNumericFromText(ch.content);
            if (n !== null) {
              const answer = mdAnswer('Answer', [`- Individuals accused: **${n}**`]);
              const citations = [{ docId: ch.doc_id, docName: 'Document', snippet: String(ch.content||'').slice(0,300), page: typeof ch.page==='number'?ch.page:null }];
              return { answer, citations, considered: { docIds: Array.from(new Set((rows2||[]).map(c=>c.doc_id))), strategy: scope } };
            }
          }
        } catch {}
        // Fallback to ContentQA in the same scope
        const docs = await metadataSearch(db, orgId, { allowedDocIds: allowed }, { limit: 10 });
      const qaChunks = await vectorSearch(db, orgId, question, docs.map(d=>d.id), { matchCount: 120, threshold: 0.3 });
        const counts = new Map();
        for (const ch of qaChunks){ counts.set(ch.doc_id, 1 + (counts.get(ch.doc_id)||0)); }
        const topDocId = (docs.map(d=>d.id).sort((a,b)=> (counts.get(b)||0)-(counts.get(a)||0))[0]) || docs[0]?.id || null;
        if (!topDocId) return { answer: 'I could not determine the count from the available excerpts.', citations: [], considered: { docIds: allowed, strategy: scope } };
        try {
          const topDoc = docs.find(d=>d.id===topDocId) || { id: topDocId, title: 'Document' };
          const topChunks = qaChunks.filter(c=>c.doc_id===topDocId).sort((a,b)=>(b.similarity||0)-(a.similarity||0)).slice(0,6);
          const { qaAboutDoc } = await import('../tools/qa-doc.js');
          const out = await qaAboutDoc({ app, db, orgId, doc: topDoc, question, topChunks });
          return { answer: out.answer, citations: out.citations || [], considered: { docIds: [topDocId], strategy: scope } };
        } catch {
          const lines = qaChunks.slice(0,3).map((c,i)=>`(${i+1}) ${String(c.content||'').slice(0,240)}`);
          return { answer: mdAnswer('Relevant excerpts', lines), citations: [], considered: { docIds: docs.map(d=>d.id), strategy: scope } };
        }
      }
      // FIR fields
      const wantFIRNo = /\bfir\b/.test(lowerQ) && /(number|no\.?)/.test(lowerQ);
      const wantFIRDate = /\bfir\b/.test(lowerQ) && /date/.test(lowerQ);
      const wantComplainant = /(complainant|informant)/.test(lowerQ);
      let firNumber = null, firDate = null, complainant = null, cited = null;
      const dateRe = /(\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\w{3,9}\s+\d{1,2},\s*\d{4}\b)/;
      const firNoRe = /(FIR\s*(?:No\.|Number)?\s*[:#-]?\s*([A-Za-z0-9\/\-]+))/i;
      const compRe = /(complainant|informant)[:\s-]+([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+)*)/i;
      for (const ch of chunks) {
        const c = String(ch.content||'');
        if (wantFIRNo && !firNumber) { const m = c.match(firNoRe); if (m) { firNumber = m[2] || m[1]; cited = ch; } }
        if (wantFIRDate && !firDate) { const m = c.match(dateRe); if (m) { firDate = m[1]; cited = ch; } }
        if (wantComplainant && !complainant) { const m = c.match(compRe); if (m) { complainant = m[2]; cited = ch; } }
        if ((wantFIRNo ? firNumber : true) && (wantFIRDate ? firDate : true) && (wantComplainant ? complainant : true)) break;
      }
      const lines = [];
      if (firNumber) lines.push(`- FIR Number: **${firNumber}**`);
      if (firDate) lines.push(`- FIR Date: **${firDate}**`);
      if (complainant) lines.push(`- Complainant: **${complainant}**`);
      if (lines.length) {
        const answer = mdAnswer('Answer', lines);
        const citations = cited ? [{ docId: cited.doc_id, docName: 'Document', snippet: String(cited.content||'').slice(0,300), page: typeof cited.page==='number'?cited.page:null }] : [];
        return { answer, citations, considered: { docIds: Array.from(new Set(chunks.map(c=>c.doc_id))), strategy: scope } };
      }
      // Fallback to ContentQA when field extraction fails
      const docs = await metadataSearch(db, orgId, { allowedDocIds: allowed }, { limit: 10 });
      const qaChunks = await vectorSearch(db, orgId, question, docs.map(d=>d.id), { matchCount: 120, threshold: 0.3 });
      const counts = new Map();
      for (const ch of qaChunks){ counts.set(ch.doc_id, 1 + (counts.get(ch.doc_id)||0)); }
      const topDocId = (docs.map(d=>d.id).sort((a,b)=> (counts.get(b)||0)-(counts.get(a)||0))[0]) || docs[0]?.id || null;
      if (!topDocId) return { answer: 'I could not find those fields in the available excerpts.', citations: [], considered: { docIds: allowed, strategy: scope } };
      try {
        const topDoc = docs.find(d=>d.id===topDocId) || { id: topDocId, title: 'Document' };
        const topChunks = qaChunks.filter(c=>c.doc_id===topDocId).sort((a,b)=>(b.similarity||0)-(a.similarity||0)).slice(0,6);
        const { qaAboutDoc } = await import('../tools/qa-doc.js');
        const out = await qaAboutDoc({ app, db, orgId, doc: topDoc, question, topChunks });
        return { answer: out.answer, citations: out.citations || [], considered: { docIds: [topDocId], strategy: scope } };
      } catch {
        const lines2 = qaChunks.slice(0,3).map((c,i)=>`(${i+1}) ${String(c.content||'').slice(0,240)}`);
        return { answer: mdAnswer('Relevant excerpts', lines2), citations: [], considered: { docIds: docs.map(d=>d.id), strategy: scope } };
      }
    }
    case 'Linked': {
      const docId = memory?.focusDocIds?.[0] || context?.docId || null;
      // Folder-scoped fallback: aggregate links across allowed doc set
      if (!docId && scope === 'folder' && Array.isArray(allowed) && allowed.length) {
        const arr = allowed.slice(0, 50); // cap for safety
        const { data: out } = await db
          .from('document_links')
          .select('doc_id, linked_doc_id')
          .eq('org_id', orgId)
          .or(`doc_id.in.(${arr.join(',')}),linked_doc_id.in.(${arr.join(',')})`);
        const ids = Array.from(new Set([...(out||[]).map(r=>r.doc_id), ...(out||[]).map(r=>r.linked_doc_id)])).filter(Boolean);
        const { data: docs } = await db
          .from('documents')
          .select('id, title, filename, document_date')
          .eq('org_id', orgId)
          .in('id', ids);
        const lines = (docs||[]).slice(0, 10).map(d=>`- ${d.title || d.filename || 'Document'} — ${d.document_date || ''}`);
        return { answer: mdAnswer('Linked Documents in Folder', lines), citations: [], considered: { docIds: ids, strategy: scope } };
      }
      if (!docId) return { answer: 'Please specify which document to show links for.', citations: [], considered: { docIds: [], strategy: scope } };
      const { data: out } = await db
        .from('document_links')
        .select('doc_id, linked_doc_id')
        .eq('org_id', orgId)
        .or(`doc_id.eq.${docId},linked_doc_id.eq.${docId}`);
      const ids = Array.from(new Set([...(out||[]).map(r=>r.doc_id), ...(out||[]).map(r=>r.linked_doc_id)])).filter(Boolean);
      const { data: docs } = await db.from('documents').select('id, title, filename, document_date').eq('org_id', orgId).in('id', ids);
      const lines = (docs||[]).map(d=>`- ${d.title || d.filename || 'Document'} — ${d.document_date || ''}`);
      return { answer: mdAnswer('Linked Documents', lines), citations: [], considered: { docIds: ids, strategy: scope } };
    }
    case 'Compare': {
      // Minimal placeholder: return top candidates to compare (implement deeper later)
      const docs = await metadataSearch(db, orgId, { allowedDocIds: allowed }, { limit: 5 });
      const lines = docs.slice(0,2).map(d => `- ${d.title || d.filename || 'Document'} — ${d.document_date || ''}`);
      return { answer: mdAnswer('Candidates to compare', lines), citations: [], considered: { docIds: docs.map(d=>d.id), strategy: scope } };
    }
    default: {
      // Folder-level aggregation for investigating officer across multiple cases
      if (scope === 'folder') {
        const wantsIO = /(investigating\s+officer|\bio\.?\b|name of i\.o\.)/i.test(question);
        const wantsMultiple = /(more than one|multiple|several|many)/i.test(question);
        if (wantsIO && wantsMultiple) {
          try {
            const { data: ioChunks } = await db
              .from('doc_chunks').select('doc_id, content, page')
              .eq('org_id', orgId).in('doc_id', allowed)
              .or('content.ilike.%Investigating Officer%,content.ilike.%I.O.%,content.ilike.%तपास अधिका%');
            const nameCounts = new Map();
            const nameSnippets = new Map();
            const pushName = (name, ch) => { const key = String(name||'').trim(); if (!key) return; nameCounts.set(key, 1 + (nameCounts.get(key)||0)); if (!nameSnippets.has(key)) nameSnippets.set(key, ch); };
            for (const ch of ioChunks || []) {
              const txt = String(ch.content||'');
              const en = txt.match(/(?:Investigating\s+Officer|I\.O\.|Name\s+of\s+I\.O\.)\s*[:\-]?\s*([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,3})/);
              if (en && en[1]) pushName(en[1], ch);
              const mr = txt.match(/तपास\s+अधिक[^\s:]*\s*[:\-]?\s*([A-Za-z\u0900-\u097F][^\n,;:]{1,40})/);
              if (mr && mr[1]) pushName(mr[1], ch);
            }
            const ranked = Array.from(nameCounts.entries()).sort((a,b)=>b[1]-a[1]);
            if (ranked.length) {
              const top = ranked.slice(0,3);
              const lines = top.map(([name,count])=>`- ${name} — mentioned in ${count} case(s)`);
              const cites = top.map(([name])=>{ const ch = nameSnippets.get(name); return ch ? { docId: ch.doc_id, docName: 'Document', snippet: String(ch.content||'').slice(0,300), page: typeof ch.page==='number'?ch.page:null } : null; }).filter(Boolean);
              return { answer: mdAnswer('Investigating officer(s) appearing in multiple cases', lines), citations: cites, considered: { docIds: Array.from(new Set((ioChunks||[]).map(c=>c.doc_id))), strategy: scope } };
            }
          } catch {}
        }
      }
      // ContentQA fallback: shortlist docs by avg top-5 similarity (boost focus/last-cited), apply filters, then answer using diverse chunks (MMR)
      const docs = await metadataSearch(db, orgId, { ...normFilters, allowedDocIds: allowed }, { limit: 10 });
      const chunks = await vectorSearch(db, orgId, question, docs.map(d=>d.id), { matchCount: 120, threshold: 0.3 });
      const focusBoost = new Set([...(memory?.focusDocIds||[]), ...(memory?.lastCitedDocIds||[])]);
      const byDoc = new Map();
      for (const ch of chunks) {
        const arr = byDoc.get(ch.doc_id) || [];
        arr.push(ch);
        byDoc.set(ch.doc_id, arr);
      }
      const scored = docs.map(d => {
        const arr = (byDoc.get(d.id) || []).sort((a,b)=>(b.similarity||0)-(a.similarity||0)).slice(0,5);
        const base = arr.length ? (arr.reduce((s,c)=>s+(c.similarity||0),0)/arr.length) : 0;
        const boost = focusBoost.has(d.id) ? 0.1 : 0;
        return { id: d.id, doc: d, score: base + boost };
      }).sort((a,b)=>b.score-a.score);
      const topDocs = scored.slice(0, Math.min(3, scored.length));
      if (topDocs.length === 0) return { answer: 'I could not find relevant documents for this question.', citations: [], considered: { docIds: [], strategy: scope } };
      function mmrSelect(list, k=6, lambda=0.7){
        const sel=[]; const usedIdx=new Set();
        const sim=(a,b)=>{ const ta=new Set(String(a.content||'').toLowerCase().split(/\s+/).slice(0,60)); const tb=new Set(String(b.content||'').toLowerCase().split(/\s+/).slice(0,60)); const inter=[...ta].filter(x=>tb.has(x)).length; return inter / Math.max(1, Math.max(ta.size,tb.size)); };
        const cand=[...list].sort((a,b)=>(b.similarity||0)-(a.similarity||0));
        while(sel.length<k && cand.length){ let best=null, bestScore=-1, bestIdx=-1; for(let i=0;i<cand.length;i++){ if(usedIdx.has(i)) continue; const rel=cand[i].similarity||0; const div = sel.length? Math.max(...sel.map(s=>sim(cand[i], s))) : 0; const mmr=lambda*rel - (1-lambda)*div; if(mmr>bestScore){ bestScore=mmr; best=cand[i]; bestIdx=i; } } if(best){ sel.push(best); usedIdx.add(bestIdx); } else break; }
        return sel;
      }
      try {
        const { qaAboutDoc } = await import('../tools/qa-doc.js');
        const { checkCoverage } = await import('../lib/coverage-checker.js');
        // Run QA for top up to 3 docs and synthesize
        const picked = topDocs.slice(0, 3);
        const perDoc = [];
        for (const td of picked) {
          const cand = (byDoc.get(td.id)||[]).sort((a,b)=>(b.similarity||0)-(a.similarity||0)).slice(0,12);
          const topChunks = mmrSelect(cand, 6, 0.7);
          const out = await qaAboutDoc({ app, db, orgId, doc: td.doc, question, topChunks });
          const snippets = topChunks.map(c=>({ content: c.content }));
          const cov = checkCoverage({ answer: out.answer, snippets, threshold: 0.15 });
          const avgSim = topChunks.length ? (topChunks.reduce((s,c)=>s+(c.similarity||0),0)/topChunks.length) : 0;
          perDoc.push({ id: td.id, title: td.doc.title || td.doc.filename || 'Document', answer: out.answer, citations: out.citations || [], coverage: cov.coverageRatio, avgSim });
        }
        // Synthesize
        const bullets = perDoc.map(r => {
          const firstSentence = String(r.answer||'').split(/(?<=[.!?])\s+/)[0] || '';
          return `- ${r.title}: ${firstSentence}`;
        }).join('\n');
        let mergedAnswer = picked.length > 1
          ? `Here is what I found across top documents:\n\n${bullets}`
          : perDoc[0]?.answer || '';
        // If strict requested, append short quotes from top doc snippets for transparency
        if (!!options?.strictCitations) {
          try {
            const best = picked[0];
            const cand = (byDoc.get(best.id)||[]).sort((a,b)=>(b.similarity||0)-(a.similarity||0)).slice(0,6);
            const quotes = cand.slice(0,3).map((c,i)=>`> ${String(c.content||'').slice(0,220)}${typeof c.page==='number'?` (p.${c.page})`:''}`).join('\n\n');
            if (quotes) mergedAnswer += `\n\n#### Quotes\n\n${quotes}`;
          } catch {}
        }
        const citations = perDoc.flatMap(r => r.citations).slice(0, 8);
        const avgCoverage = perDoc.length ? (perDoc.reduce((s,r)=>s+r.coverage,0)/perDoc.length) : 0;
        const avgSim = perDoc.length ? (perDoc.reduce((s,r)=>s+r.avgSim,0)/perDoc.length) : 0;
        const confidence = Math.max(0, Math.min(1, 0.5*avgCoverage + 0.5*Math.min(1, avgSim)));
        const strict = !!options?.strictCitations;
        if (strict && (citations.length === 0 || avgCoverage < 0.5)) {
          const ask = 'To narrow this down, please specify a date range (e.g., 2021-01 to 2021-12), document type (e.g., inspection, invoice), or sender/receiver.';
          return { answer: `I don\'t have enough grounded evidence to answer precisely. ${ask}`, citations: [], considered: { docIds: picked.map(t=>t.id), strategy: scope }, coverage: avgCoverage, confidence };
        }
        return { answer: mergedAnswer || 'No answer.', citations, considered: { docIds: picked.map(t=>t.id), strategy: scope }, coverage: avgCoverage, confidence };
      } catch {
        const cand = (byDoc.get(topDocs[0].id)||[]).sort((a,b)=>(b.similarity||0)-(a.similarity||0)).slice(0,6);
        const lines = cand.slice(0,3).map((c,i)=>`(${i+1}) ${String(c.content||'').slice(0,240)}`);
        return { answer: mdAnswer('Relevant excerpts (AI temporarily unavailable)', lines), citations: [], considered: { docIds: topDocs.map(t=>t.id), strategy: scope } };
      }
    }
  }
}
