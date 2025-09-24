// Test Agent Routes - REST-based implementation
// This file implements the REST version of the agentic chat functionality

import { z } from 'zod';
import { routeQuestion } from '../agents/ai-router.js';
import EnhancedAgentOrchestrator from '../agents/enhanced-orchestrator.js';
import { generateEmbedding } from '../lib/embeddings.js';
import { rerankCandidates } from '../lib/rerank-service.js';
import { isAIDegraded, generateDegradedResponse } from '../lib/graceful-degradation.js';

/**
 * Register test agent routes
 * @param {Object} app - Fastify app instance
 */
export function registerTestAgentRoutes(app) {
  console.log('🧪 Registering test agent routes...');

  // Unified REST chat endpoint with context scoping (doc | folder | org)
  // Response is non-streaming JSON with grounded citations.
  app.post('/orgs/:orgId/chat/query', {
    preHandler: [app.verifyAuth, app.requireIpAccess]
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;

    const Schema = z.object({
      question: z.string().min(1),
      conversation: z
        .array(z.object({
          role: z.enum(['user', 'assistant']).optional(),
          content: z.string().optional(),
          citations: z.array(z.object({ docId: z.string().optional() })).optional(),
        }))
        .optional(),
      memory: z
        .object({
          focusDocIds: z.array(z.string()).optional(),
          lastCitedDocIds: z.array(z.string()).optional(),
          lastListDocIds: z.array(z.string()).optional(),
          filters: z
            .object({ sender: z.string().optional(), receiver: z.string().optional(), docType: z.string().optional() })
            .optional(),
        })
        .optional(),
      useToolPlanner: z.boolean().optional(),
      context: z.object({
        scope: z.enum(['doc', 'folder', 'org']).default('org'),
        docId: z.string().optional(),
        folderPath: z.array(z.string()).optional(),
        includeSubfolders: z.boolean().optional().default(true),
        includeLinked: z.boolean().optional().default(false),
        includeVersions: z.boolean().optional().default(false),
      }).optional(),
      filters: z.object({
        sender: z.string().optional(),
        receiver: z.string().optional(),
        docType: z.string().optional(),
        category: z.string().optional(),
        dateRange: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
      }).optional(),
      strictCitations: z.boolean().optional(),
    });

    const { question, conversation = [], memory: userMemory = {}, context = { scope: 'org' }, filters = {}, useToolPlanner: useToolPlannerFlag, strictCitations } = Schema.parse(req.body || {});

    try {

      // Simple detector for list/find/show queries
      const isListQuery = (txt) => {
        const s = String(txt || '').toLowerCase();
        const hasListVerb = /\b(find|show|list|display)\b/.test(s) || /\ball\b/.test(s);
        const hasDocNoun = /\b(doc|docs|document|documents|file|files|records|papers|items)\b/.test(s);
        return hasListVerb && hasDocNoun;
      };
      const parseOrdinal = (txt) => {
        const m = String(txt || '').toLowerCase().match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|#(\d+))\b/);
        if (!m) return null;
        const map = new Map([
          ['first',1],['second',2],['third',3],['fourth',4],['fifth',5],
          ['1st',1],['2nd',2],['3rd',3],['4th',4],['5th',5]
        ]);
        if (m[2]) return Number(m[2]);
        const v = map.get(m[1]);
        return v || null;
      };
      // Build allowed doc set from context
      const allowedDocIds = new Set(await computeAllowedDocIds(db, orgId, context));

      // Deterministic ordinal handling using memory.lastListDocIds (safe — no LLM)
      const lastListDocIds = Array.isArray(userMemory.lastListDocIds) ? userMemory.lastListDocIds : [];
      const ord = parseOrdinal(question);
      if (ord && lastListDocIds.length > 0) {
        const idx = Math.max(0, ord - 1);
        const targetId = lastListDocIds[idx];
        if (targetId && allowedDocIds.has(targetId)) {
          const { data: doc } = await db
            .from('documents')
            .select('id, title, filename, subject, sender, receiver, document_date, category, type')
            .eq('org_id', orgId)
            .eq('id', targetId)
            .maybeSingle();
          if (doc) {
            const name = doc.title || doc.filename || 'Untitled';
            const parts = [name];
            if (doc.document_date) parts.push(String(doc.document_date));
            if (doc.type) parts.push(String(doc.type));
            if (doc.sender) parts.push(String(doc.sender));
            const answer = `### Details for the ${ord}${ord===1?'st':ord===2?'nd':ord===3?'rd':'th'} item\n\n- ${parts.join(' — ')}`;
            return reply.send({
              answer,
              citations: [{ docId: doc.id, docName: name, snippet: `${name} — ${doc.document_date || ''}` }],
              agent: { type: 'metadata', name: 'OrdinalSelector', confidence: 0.95 },
              considered: { docIds: [doc.id], strategy: 'ordinal_memory' },
              executionTrace: []
            });
          }
        }
      }


      // If AI is degraded, return degraded response (after planner attempt)
      if (isAIDegraded()) {
        const degraded = await generateDegradedResponse({ question, documents: [], conversation, orgId, db });
        return reply.send({
          answer: degraded.answer,
          citations: degraded.citations || [],
          agent: { type: 'degraded', name: 'Fallback', confidence: degraded.confidence || 0.4 },
          considered: { docIds: [], strategy: 'degraded' },
          executionTrace: [],
          degraded: true,
          reason: degraded.reason || 'DEGRADED'
        });
      }

      // Route the question (skip for doc/folder scope to avoid unnecessary LLM calls)
      const routingResult = (context?.scope === 'doc' || context?.scope === 'folder') ? null : await routeQuestion(question, conversation);

      // Retrieval
      let documents = [];
      let queryEmbedding = null;
      try {
        // Compute embedding once for downstream enrichment (avoid duplicate calls)
        queryEmbedding = await generateEmbedding(question);

        // If user scoped to a specific doc, hard-focus that doc
        if (context?.scope === 'doc' && context.docId) {
          const docIds = Array.from(allowedDocIds);
          const { data: docDetails } = await db
            .from('documents')
            .select('id, title, filename, subject, sender, receiver, document_date, category, type')
            .eq('org_id', orgId)
            .in('id', docIds);
          if (docDetails && docDetails.length > 0) {
            // Enrich the primary doc with top-matching chunks
            let byDocSnippets = new Map();
            if (queryEmbedding) {
              try {
                // For numerical queries, increase match count and lower threshold to catch more candidates
                const isNumQuery = isNumericalQuery(question);
                const matchCount = isNumQuery ? 150 : 80;  // Increase for numerical queries
                const similarityThreshold = isNumQuery ? 0.1 : 0.2;  // Lower threshold for numerical queries
                
                const { data: chunks } = await db.rpc('match_doc_chunks', {
                  p_org_id: orgId,
                  p_query_embedding: queryEmbedding,
                  p_match_count: matchCount,
                  p_similarity_threshold: similarityThreshold,
                });
                if (Array.isArray(chunks)) {
                  for (const ch of chunks) {
                    if (!allowedDocIds.has(ch.doc_id)) continue;
                    const arr = byDocSnippets.get(ch.doc_id) || [];
                    arr.push(ch);
                    byDocSnippets.set(ch.doc_id, arr);
                  }
                }
              } catch {}
            }
            // Build document objects with best-effort content
            documents = [];
            for (const d of docDetails) {
              let list = (byDocSnippets.get(d.id) || [])
                .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
                .slice(0, 5);
              
              // For numerical queries, also look for chunks containing numerical values
              if (isNumericalQuery(question)) {
                // Get all chunks for this document to extract numerical entities
                try {
                  const { data: allChunks } = await app.supabaseAdmin
                    .from('doc_chunks')
                    .select('content, similarity')
                    .eq('org_id', orgId)
                    .eq('doc_id', d.id)
                    .limit(100);
                  
                  if (Array.isArray(allChunks)) {
                    // Extract numerical entities from all content
                    let allContent = allChunks.map(c => c.content || '').join(' ');
                    const numericalEntities = extractNumericalEntities(allContent);
                    
                    // Find chunks that contain these numerical values
                    const chunksWithNumbers = findChunksWithNumericalValues(allChunks, numericalEntities);
                    
                    // Boost these chunks by adding them to our list with higher similarity scores
                    for (const chunk of chunksWithNumbers) {
                      // Only add if not already in list
                      if (!list.some(existing => existing.content === chunk.content)) {
                        list.push({
                          ...chunk,
                          similarity: (chunk.similarity || 0) + 0.5  // Boost similarity
                        });
                      }
                    }
                    
                    // Re-sort with boosted scores
                    list = list
                      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
                      .slice(0, 10);  // Increase slice for numerical queries
                  }
                } catch (err) {
                  req.log?.warn?.(err, 'Failed to process numerical entities for document');
                }
              }
              
              const parts = [];
              const seen = new Set();
              for (const c of list) {
                const txt = String(c.content || '').trim();
                if (txt && !seen.has(txt)) { parts.push(txt); seen.add(txt); }
              }
              let content = parts.join('\n---\n');
              // Fallback 1: load extraction summary from storage
              if (!content) {
                try {
                  const key = `${orgId}/${d.id}.json`;
                  const dl = await app.supabaseAdmin.storage.from('extractions').download(key);
                  if (dl?.data) {
                    const txt = await dl.data.text();
                    const payload = JSON.parse(txt);
                    if (payload?.summary && typeof payload.summary === 'string') {
                      content = String(payload.summary).slice(0, 2000);
                    } else if (Array.isArray(payload?.pages)) {
                      const first = payload.pages.slice(0, 2).map((p) => String(p.text || '').trim()).filter(Boolean);
                      if (first.length) content = first.join('\n---\n');
                    }
                  }
                } catch {}
              }
              // Fallback 2: fetch first few chunks sequentially (no embedding)
              if (!content) {
                try {
                  const { data: chunkRows } = await app.supabaseAdmin
                    .from('doc_chunks')
                    .select('content')
                    .eq('org_id', orgId)
                    .eq('doc_id', d.id)
                    .order('chunk_index', { ascending: true })
                    .limit(5);
                  const texts = (chunkRows || []).map(r => String(r.content || '').trim()).filter(Boolean);
                  if (texts.length) content = texts.join('\n---\n');
                } catch {}
              }
              // Fallback 3: use subject/title if still blank
              if (!content) content = d.subject || d.title || d.filename || '';

              documents.push({
                id: d.id,
                title: d.title || d.filename || 'Untitled',
                name: d.title || d.filename || 'Untitled',
                content,
                documentDate: d.document_date,
                sender: d.sender,
                receiver: d.receiver,
                documentType: d.type,
                category: d.category,
              });
            }
          }
        } else {
          // Org/folder scopes: use hybrid search then filter to allowedDocIds if present
          const { hybridSearch } = await import('../lib/metadata-embeddings.js');
          const searchResults = await hybridSearch(db, orgId, question, { limit: 50, threshold: 0.3 });
          const filtered = Array.isArray(searchResults)
            ? (allowedDocIds.size ? searchResults.filter(r => allowedDocIds.has(r.doc_id)) : searchResults)
            : [];
          const topIds = [...new Set(filtered.map(r => r.doc_id))].slice(0, 20);
          if (topIds.length > 0) {
            const { data: docDetails } = await db
              .from('documents')
              .select('id, title, filename, subject, sender, receiver, document_date, category, type')
              .eq('org_id', orgId)
              .in('id', topIds);
            const docMap = new Map((docDetails || []).map(d => [d.id, d]));
            documents = topIds
              .map((id) => docMap.get(id))
              .filter(Boolean)
              .filter((d) => d.type !== 'folder')
              .map((d) => ({
                id: d.id,
                title: d.title || d.filename || 'Untitled',
                name: d.title || d.filename || 'Untitled',
                content: '',
                documentDate: d.document_date,
                sender: d.sender,
                receiver: d.receiver,
                documentType: d.type,
                category: d.category,
              }));

            // Boost focus and last-cited docs first
            try {
              const boost = new Set([...(userMemory?.focusDocIds||[]), ...(userMemory?.lastCitedDocIds||[])]);
              if (boost.size) {
                documents.sort((a,b)=> (boost.has(a.id)?1:0) === (boost.has(b.id)?1:0) ? 0 : (boost.has(a.id)?-1:1));
              }
            } catch {}

            // If this is a list/find query, return a list without any generation
            if (isListQuery(question)) {
              const lines = documents.slice(0, 10).map(d => {
                const parts = [d.name];
                if (d.documentDate) parts.push(d.documentDate);
                if (d.documentType) parts.push(d.documentType);
                if (d.category) parts.push(d.category);
                if (d.sender) parts.push(d.sender);
                return `- ${parts.join(' — ')}`;
              });
              const answer = lines.length ? `### Top results\n\n${lines.join('\n')}` : 'No matching documents found.';
              return reply.send({
                answer,
                citations: [],
                agent: { type: 'search', name: 'ListDocs', confidence: 0.99 },
                considered: { docIds: documents.map(d => d.id), strategy: context?.scope || 'org' },
                executionTrace: [],
              });
            }

            // Snippet enrichment restricted to these doc IDs
            if (queryEmbedding) {
              try {
                const { data: chunks } = await db.rpc('match_doc_chunks', {
                  p_org_id: orgId,
                  p_query_embedding: queryEmbedding,
                  p_match_count: 80,
                  p_similarity_threshold: 0.3,
                });
                if (Array.isArray(chunks)) {
                  const allowed = new Set(documents.map(d => d.id));
                  const byDoc = new Map();
                  for (const ch of chunks) {
                    if (!allowed.has(ch.doc_id)) continue;
                    const arr = byDoc.get(ch.doc_id) || [];
                    arr.push(ch);
                    byDoc.set(ch.doc_id, arr);
                  }
                  documents = documents.map(d => {
                    const list = (byDoc.get(d.id) || [])
                      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
                      .slice(0, 3);
                    const parts = [];
                    const seen = new Set();
                    for (const c of list) {
                      const txt = String(c.content || '').trim();
                      if (txt && !seen.has(txt)) { parts.push(txt); seen.add(txt); }
                    }
                    const merged = parts.join('\n---\n');
                    return { ...d, content: merged || d.content };
                  });
                }
              } catch {}
            }
          }
        }
      } catch (retrievalErr) {
        req.log?.error?.(retrievalErr, 'REST retrieval failed');
      }

      // If doc-scoped and we have at least one doc, use AI policy controller to select tool (fallback to deterministic)
      if (context?.scope === 'doc' && documents.length > 0) {
        try {
          const targetDoc = documents[0];
          let taskSel;
          try {
            const [{ decideTaskAI }] = await Promise.all([
              import('../lib/ai-policy-controller.js'),
            ]);
            taskSel = await decideTaskAI(context, question, {
              memory: userMemory,
              docMeta: { title: targetDoc.title, filename: targetDoc.name, type: targetDoc.documentType, category: targetDoc.category }
            });
          } catch {}
          // Prefer AI decision. Only fall back if the policy call failed entirely.
          if (!taskSel || !taskSel.task) {
            const [{ decideTask }] = await Promise.all([ import('../lib/task-controller.js') ]);
            taskSel = decideTask(context, question, {});
          }

          // Ask for clarification if requested by policy
          if (taskSel?.requires_clarification && taskSel?.clarify) {
            return reply.send({
              answer: taskSel.clarify,
              citations: [],
              agent: { type: 'policy', name: 'Clarify', confidence: taskSel.confidence || 0.5 },
              considered: { docIds: [targetDoc.id], strategy: 'doc' },
              executionTrace: [],
            });
          }

          try { req.log?.info({ policyTask: taskSel?.task, policyConfidence: taskSel?.confidence, question }, 'AI policy decided task'); } catch {}

          // Prepare top chunks for QA/summarize with windowing
          let topChunks = [];
          try {
            const emb = queryEmbedding || await generateEmbedding(question);
            if (emb) {
              const { data: chunks } = await db.rpc('match_doc_chunks', {
                p_org_id: orgId,
                p_query_embedding: emb,
                p_match_count: 60,
                p_similarity_threshold: 0.25,
              });
              const anchors = (chunks || []).filter(c => c.doc_id === targetDoc.id)
                .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
                .slice(0, 6);
              // Window around anchor pages
              const [{ buildWindowedChunks }] = await Promise.all([
                import('../lib/chunk-window.js')
              ]);
              const windowed = await buildWindowedChunks({ db, orgId, docId: targetDoc.id, anchorChunks: anchors, windowPages: 1, maxPerPage: 12 });
              // Lexical anchor fallback for numeric/billing sections (generic, no regex): include chunks containing key phrases if present
              try {
                const keys = ['TOTAL CURRENT BILL','Demand Charges','Charges For Excess Demand','BILL MONTH','Bill Amount'];
                const { data: kwRows } = await db
                  .from('doc_chunks')
                  .select('doc_id, content, page')
                  .eq('org_id', orgId)
                  .eq('doc_id', targetDoc.id)
                  .or(keys.map(k => `content.ilike.%${k}%`).join(','))
                  .limit(60);
                for (const r of kwRows || []) windowed.push({ ...r, similarity: 0.3 });
              } catch {}
              // Simple MMR selection
              const mmrSelect = (list, k=8, lambda=0.7) => {
                const sel=[]; const used=new Set();
                const sim=(a,b)=>{ const ta=new Set(String(a.content||'').toLowerCase().split(/\s+/).slice(0,60)); const tb=new Set(String(b.content||'').toLowerCase().split(/\s+/).slice(0,60)); const inter=[...ta].filter(x=>tb.has(x)).length; return inter/Math.max(1,Math.max(ta.size,tb.size)); };
                const cand=[...list].sort((a,b)=>(b.similarity||0)-(a.similarity||0));
                while(sel.length<k && cand.length){ let best=null, bestScore=-1, idx=-1; for(let i=0;i<cand.length;i++){ if(used.has(i)) continue; const rel=cand[i].similarity||0; const div= sel.length? Math.max(...sel.map(s=>sim(cand[i],s))) : 0; const score=lambda*rel - (1-lambda)*div; if(score>bestScore){ bestScore=score; best=cand[i]; idx=i; } } if(best){ sel.push(best); used.add(idx); } else break; }
                return sel;
              };
              topChunks = mmrSelect(windowed, 8, 0.7);
            }
          } catch {}

          if (taskSel.task === 'LinkedContext') {
            const { linkedContext } = await import('../tools/linked-context.js');
            const out = await linkedContext({ app, db, orgId, docId: targetDoc.id, question, includeVersions: !!context.includeVersions, includeLinked: true });
            const { verifyAnswer } = await import('../lib/answer-verifier.js');
            const v = verifyAnswer({ task: 'QAAboutDoc', answer: out.answer, citations: out.citations, targetDocId: null });
            return reply.send({
              answer: v.answer,
              citations: out.citations || [],
              agent: { type: 'content', name: 'LinkedContext', confidence: 0.85 },
              considered: { docIds: [], strategy: 'doc+linked' },
              executionTrace: [],
            });
          }

          if (taskSel.task === 'MetadataQA') {
            const { metadataQA } = await import('../tools/metadata-qa.js');
            const out = await metadataQA({ db, orgId, docId: targetDoc.id, question });
            const { verifyAnswer } = await import('../lib/answer-verifier.js');
            const v = verifyAnswer({ task: 'MetadataQA', answer: out.answer, citations: out.citations, targetDocId: targetDoc.id });
            return reply.send({
              answer: v.answer,
              citations: out.citations || [],
              agent: { type: 'metadata', name: 'MetadataQA', confidence: 0.95 },
              considered: { docIds: [targetDoc.id], strategy: 'doc' },
              executionTrace: [],
            });
          }

          if (taskSel.task === 'QAAboutDoc') {
            // Decide if structured QA is needed
            let useStructured = false;
            try {
              const [{ classifyDocIntent }] = await Promise.all([ import('../lib/doc-intent.js') ]);
              const intent = await classifyDocIntent(question);
              useStructured = intent?.mode === 'TableExtract' || intent?.mode === 'VerifySum';
            } catch {}
            // Heuristic hint: verification/sum and table/month keywords trigger structured path as well (generic, no regex extractors)
            const ql = String(question||'').toLowerCase();
            const tableHints = ['bill month','table','month-wise','consumption','units','bill amount','august','september','october','november','december','january'];
            if (/(verify|sum|add up|discrepancy|difference)/i.test(ql) || ql.includes('total current bill') || tableHints.some(k => ql.includes(k))) {
              useStructured = true;
            }
            let out;
            if (useStructured) {
              const [{ structuredQA }] = await Promise.all([ import('../tools/structured-qa.js') ]);
              const contextText = topChunks.map(c => String(c.content||'')).join('\n---\n');
              out = await structuredQA({ question, contextText });
              // Attach citations from selected chunks (pages)
              const cites = topChunks.slice(0,5).map(c => ({ docId: targetDoc.id, docName: targetDoc.title || targetDoc.name || 'Document', snippet: String(c.content||'').slice(0,300), page: typeof c.page==='number'?c.page:null }));
              out.citations = cites;
            } else {
              const { qaAboutDoc } = await import('../tools/qa-doc.js');
              out = await qaAboutDoc({ app, db, orgId, doc: targetDoc, question, topChunks });
            }
            // Finalize formatting in Markdown
            try {
              const [{ isProviderBackedOff }] = await Promise.all([ import('../lib/ai-service.js') ]);
              if (!isProviderBackedOff()) {
                const [{ finalizeAnswer }] = await Promise.all([ import('../lib/answer-finalizer.js') ]);
                out.answer = await finalizeAnswer(question, out.answer || '');
              }
            } catch {}
            const { verifyAnswer } = await import('../lib/answer-verifier.js');
            const v = verifyAnswer({ task: 'QAAboutDoc', answer: out.answer, citations: out.citations, targetDocId: targetDoc.id });
            return reply.send({
              answer: v.answer,
              citations: out.citations || [],
              agent: { type: 'content', name: 'DocQA', confidence: 0.9 },
              considered: { docIds: [targetDoc.id], strategy: 'doc' },
              executionTrace: [],
            });
          }

          // Default to SummarizeDoc
          const { summarizeDoc } = await import('../tools/summarize-doc.js');
          // Ensure contentText present
          let contentText = String(targetDoc.content || '').trim();
          if (!contentText) {
            try {
              const { data: chunkRows } = await app.supabaseAdmin
                .from('doc_chunks')
                .select('content')
                .eq('org_id', orgId)
                .eq('doc_id', targetDoc.id)
                .order('chunk_index', { ascending: true })
                .limit(5);
              const texts = (chunkRows || []).map(r => String(r.content || '').trim()).filter(Boolean);
              if (texts.length) contentText = texts.join('\n---\n');
            } catch {}
          }
          const out = await summarizeDoc({ app, db, orgId, doc: targetDoc, contentText, topChunks });
          const { verifyAnswer } = await import('../lib/answer-verifier.js');
          const v = verifyAnswer({ task: 'SummarizeDoc', answer: out.answer, citations: out.citations, targetDocId: targetDoc.id });
          return reply.send({
            answer: v.answer,
            citations: out.citations || [],
            agent: { type: 'content', name: 'Summarizer', confidence: 0.9 },
            considered: { docIds: [targetDoc.id], strategy: 'doc' },
            executionTrace: [],
          });
        } catch (e) {
          req.log?.warn?.(e, 'doc-scope controller failed; falling back to orchestrator');
        }
      }

      // If folder-scoped, use AI policy to select tool; deterministic ops for list/count; otherwise FolderQA
      if (context?.scope === 'folder') {
        try {
          const { folderSearch } = await import('../tools/folder-search.js');
          // AI policy decision
          let policy = null;
          try {
            const [{ decideTaskAI }] = await Promise.all([ import('../lib/ai-policy-controller.js') ]);
            policy = await decideTaskAI({ scope: 'folder' }, question, { memory: userMemory });
            try { req.log?.info({ folderPolicyTask: policy?.task, policyConfidence: policy?.confidence }, 'AI folder policy decided task'); } catch {}
          } catch {}
          // If list query (detected OR policy says ListDocs), produce listing directly from allowedDocIds
          const isListQuery = (txt) => {
            const s = String(txt || '').toLowerCase();
            const hasListVerb = /\b(find|show|list|display)\b/.test(s) || /\ball\b/.test(s);
            const hasDocNoun = /\b(doc|docs|document|documents|file|files|records|papers|items)\b/.test(s);
            return hasListVerb && hasDocNoun;
          };
          if (policy?.task === 'ListDocs' || isListQuery(question)) {
            // Scoped hybrid search in folder
            let ids = Array.from(allowedDocIds);
            const { hybridSearch } = await import('../lib/metadata-embeddings.js');
            try {
              const results = await hybridSearch(db, orgId, question, { limit: 50, threshold: 0.3 });
              const filtered = (results || []).filter(r => allowedDocIds.has(r.doc_id));
              ids = filtered.length ? filtered.map(r => r.doc_id) : ids.slice(0, 20);
            } catch {}
            const { data: docRows } = await db
              .from('documents')
              .select('id, title, filename, document_date, category, type, sender')
              .eq('org_id', orgId)
              .in('id', ids);
            const docs = (docRows || []).filter(d => d.type !== 'folder');
            const lines = docs.slice(0, 10).map(d => {
              const name = d.title || d.filename || 'Document';
              const parts = [name];
              if (d.document_date) parts.push(d.document_date);
              if (d.type) parts.push(d.type);
              if (d.category) parts.push(d.category);
              if (d.sender) parts.push(d.sender);
              return `- ${parts.join(' — ')}`;
            });
            const answer = lines.length ? `### Top results in folder\n\n${lines.join('\n')}` : 'No matching documents found in this folder.';
            return reply.send({
              answer,
              citations: [],
              agent: { type: 'search', name: 'ListDocs', confidence: policy?.confidence || 0.99 },
              considered: { docIds: docs.map(d => d.id), strategy: 'folder' },
              executionTrace: [],
            });
          }
          // Count of documents only (avoid intercepting entity/content questions)
          const isDocCountQuery = (txt) => /\b(how many|count|total number)\b/i.test(String(txt || '')) && /\b(documents?|docs?|files?|records?|items?)\b/i.test(String(txt || ''));
          // Entity/content count queries like "how many individuals were accused"
          const isEntityCountQuery = (txt) => /\b(how many|number of|count of)\b/i.test(String(txt || '')) && !/\b(documents?|docs?|files?|records?|items?)\b/i.test(String(txt || ''));
          if (isListQuery(question)) {
            const ids = Array.from(allowedDocIds).slice(0, 20);
            const { data: docRows } = await db
              .from('documents')
              .select('id, title, filename, document_date, category, type, sender')
              .eq('org_id', orgId)
              .in('id', ids);
            const docs = (docRows || []).filter(d => d.type !== 'folder');
            const lines = docs.slice(0, 10).map(d => {
              const name = d.title || d.filename || 'Document';
              const parts = [name];
              if (d.document_date) parts.push(d.document_date);
              if (d.type) parts.push(d.type);
              if (d.category) parts.push(d.category);
              if (d.sender) parts.push(d.sender);
              return `- ${parts.join(' — ')}`;
            });
            const answer = lines.length ? `### Top results in folder\n\n${lines.join('\n')}` : 'No matching documents found in this folder.';
            return reply.send({
              answer,
              citations: [],
              agent: { type: 'search', name: 'ListDocs', confidence: 0.99 },
              considered: { docIds: docs.map(d => d.id), strategy: 'folder' },
              executionTrace: [],
            });
          }
          // Folder document count without LLM (explicit pattern only)
          if (isDocCountQuery(question)) {
            const count = allowedDocIds.size;
            const answer = `### Folder Summary\n\n- Total documents: **${count}**`;
            return reply.send({
              answer,
              citations: [],
              agent: { type: 'analytics', name: 'FolderCount', confidence: 0.99 },
              considered: { docIds: Array.from(allowedDocIds), strategy: 'folder' },
              executionTrace: [],
            });
          }

          // Try lightweight entity count extraction from chunks (no LLM)
          if (isEntityCountQuery(question)) {
            // Heuristic extraction targeting phrases near "accused"/"individuals"
            const terms = ['accused', 'individual', 'individuals', 'persons', 'people'];
            const wordToNum = (w) => ({
              'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
              'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20
            })[String(w||'').toLowerCase()] ?? null;
            const extractNum = (txt) => {
              const patterns = [
                /(\d+)\s+(?:accused|individuals?|persons?|people)/i,
                /(?:accused|individuals?|persons?|people)\s+(?:were|was|are|is)?\s*(\d+)/i,
                /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b\s+(?:accused|individuals?|persons?|people)/i
              ];
              for (const re of patterns) {
                const m = String(txt||'').match(re);
                if (m && m[1]) {
                  const n = Number(m[1]);
                  if (!isNaN(n)) return n;
                  const w = wordToNum(m[1]);
                  if (w !== null) return w;
                }
              }
              return null;
            };
            let chunks = [];
            try {
              const emb = await generateEmbedding(question).catch(() => null);
              if (emb) {
                const { data: rows } = await db.rpc('match_doc_chunks', {
                  p_org_id: orgId,
                  p_query_embedding: emb,
                  p_match_count: 80,
                  p_similarity_threshold: 0.15,
                });
                chunks = (rows || []).filter(r => allowedDocIds.has(r.doc_id));
              }
            } catch {}
            // Lexical fallback if no embedding
            if (chunks.length === 0) {
              try {
                const ids = Array.from(allowedDocIds);
                const { data: rows } = await db
                  .from('doc_chunks')
                  .select('doc_id, content, page')
                  .eq('org_id', orgId)
                  .in('doc_id', ids)
                  .ilike('content', '%accused%')
                  .limit(100);
                chunks = rows || [];
              } catch {}
            }
            // Scan chunks for a numeric answer
            let found = null; let foundChunk = null;
            for (const ch of chunks) {
              const c = String(ch.content || '');
              if (!terms.some(t => c.toLowerCase().includes(t))) continue;
              const n = extractNum(c);
              if (n !== null) { found = n; foundChunk = ch; break; }
            }
            if (found !== null) {
              const answer = `### Answer\n\n- Individuals accused: **${found}**`;
              const citations = foundChunk ? [{
                docId: foundChunk.doc_id,
                docName: 'Document',
                snippet: String(foundChunk.content || '').slice(0, 300),
                page: typeof foundChunk.page === 'number' ? foundChunk.page : null
              }] : [];
              return reply.send({
                answer,
                citations,
                agent: { type: 'content', name: 'HeuristicExtractor', confidence: 0.7 },
                considered: { docIds: Array.from(new Set(chunks.map(c => c.doc_id))), strategy: 'folder' },
                executionTrace: [],
              });
            }
          }
          // If AI services are degraded, return degraded response for folder scope
          const { isAIDegraded, generateDegradedResponse } = await import('../lib/graceful-degradation.js');
          if (isAIDegraded()) {
            const degraded = await generateDegradedResponse({ question, documents: [], conversation, orgId, db });
            return reply.send({
              answer: degraded.answer,
              citations: degraded.citations || [],
              agent: { type: 'degraded', name: 'Fallback', confidence: degraded.confidence || 0.4 },
              considered: { docIds: Array.from(allowedDocIds), strategy: 'folder' },
              executionTrace: [],
              degraded: true,
              reason: degraded.reason || 'DEGRADED'
            });
          }
          // Prefer folder-level multi-doc QA when policy asks for FolderQA or as default
          const { folderMultiDocQA } = await import('../tools/folder-qa.js');
          const out = await folderMultiDocQA({ app, db, orgId, question, allowedDocIds: Array.from(allowedDocIds), maxDocs: 3, options: { strictCitations: !!strictCitations } });
          return reply.send({
            answer: out.answer,
            citations: out.citations || [],
            agent: { type: 'content', name: 'FolderQA', confidence: out.confidence || (policy?.confidence || 0.8) },
            considered: out.considered || { docIds: Array.from(allowedDocIds), strategy: 'folder' },
            coverage: typeof out.coverage === 'number' ? out.coverage : undefined,
            executionTrace: [],
          });
        } catch (e) {
          req.log?.warn?.(e, 'folderSearch failed; falling back to orchestrator');
        }
      }

      // Rerank to keep best few
      try {
        documents = await rerankCandidates(question, [], documents, 5);
      } catch {}

      // Process with orchestrator (single or coordinated depending on agent)
      let agentResult;
      try {
        if (agentOrchestrator?.enhancedOrchestrator?.processWithCoordination) {
          agentResult = await agentOrchestrator.enhancedOrchestrator.processWithCoordination(
            db, 
            question, 
            documents, 
            conversation,
            routingResult,
            { perAgentTimeoutMs: 8000, overallTimeoutMs: 15000, secondaryMax: 2 }
          );
        } else {
          agentResult = await agentOrchestrator.processWithCoordination(
            db, 
            question, 
            documents, 
            conversation,
            routingResult,
            { perAgentTimeoutMs: 8000, overallTimeoutMs: 15000, secondaryMax: 2 }
          );
        }
      } catch (agentErr) {
        req.log?.error?.(agentErr, 'REST agent processing failed');
        agentResult = {
          answer: "I couldn't process your request right now.",
          citations: [],
          agentType: routingResult?.agentType || 'content',
          agentName: routingResult?.agentName || 'Content Agent',
          confidence: routingResult?.confidence || 0.4,
        };
      }

      // Normalize response: ensure citations are within allowed set (when scoped)
      if (allowedDocIds.size && Array.isArray(agentResult?.citations)) {
        agentResult.citations = agentResult.citations.filter(c => c && c.docId && allowedDocIds.has(c.docId));
      }

      return reply.send({
        answer: agentResult.answer,
        citations: agentResult.citations || [],
        agent: {
          type: agentResult.agentType || routingResult?.agentType || 'content',
          name: agentResult.agentName || routingResult?.agentName || 'Content Agent',
          confidence: agentResult.confidence || routingResult?.confidence || 0.5,
        },
        considered: {
          docIds: documents.map(d => d.id),
          strategy: context?.scope || 'org',
        },
        executionTrace: agentResult.executionTrace || [],
      });
    } catch (error) {
      req.log?.error?.(error, 'REST /chat/query failed');
      // Try degraded mode as last resort
      try {
        const degraded = await generateDegradedResponse({ question, documents: [], conversation, orgId, db });
        return reply.send({
          answer: degraded.answer,
          citations: degraded.citations || [],
          agent: { type: 'degraded', name: 'Fallback', confidence: degraded.confidence || 0.3 },
          considered: { docIds: [], strategy: 'degraded_catch' },
          executionTrace: [],
          degraded: true,
          reason: degraded.reason || 'DEGRADED'
        });
      } catch {
        return reply.code(500).send({
          answer: "Something went wrong.",
          citations: [],
          agent: { type: 'error', name: 'Error Handler', confidence: 0.1 },
          error: error?.message || 'internal_error'
        });
      }
    }
  });

  // REST-based chat endpoint (non-streaming)
  app.post('/orgs/:orgId/chat/ask-rest', { 
    preHandler: [app.verifyAuth, app.requireIpAccess] 
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    
    const Schema = z.object({
      question: z.string().min(1),
      conversation: z
        .array(z.object({
          role: z.enum(['user', 'assistant']).optional(),
          content: z.string().optional(),
          citations: z.array(z.object({ docId: z.string().optional() })).optional(),
        }))
        .optional(),
      memory: z
        .object({
          focusDocIds: z.array(z.string()).optional(),
          lastCitedDocIds: z.array(z.string()).optional(),
          filters: z
            .object({ sender: z.string().optional(), receiver: z.string().optional(), docType: z.string().optional() })
            .optional(),
        })
        .optional(),
    });
    
    const { question, conversation = [], memory: userMemory = {} } = Schema.parse(req.body || {});

    try {
      // Use enhanced router once and pass downstream
      const routingResult = await routeQuestion(question, conversation);
      const plan = buildQueryPlan(question, routingResult);
      const filters = await extractFilters(question);
      const isFindFiles = (routingResult?.intent === 'FindFiles') || (routingResult?.agentType === 'metadata');
      
      // Retrieve relevant documents for the query
      // Use hybrid search to get documents relevant to the question
      let documents = [];
      try {
        if (isFindFiles) {
          // Metadata-only retrieval for FindFiles intent
          const embedding = await generateEmbedding(question);
          if (embedding) {
            const { data: metaRows, error: metaErr } = await db.rpc('search_metadata_embeddings', {
              p_org_id: orgId,
              p_query_embedding: embedding,
              p_field_types: null,
              p_limit: 60,
              p_similarity_threshold: 0.45
            });
            if (!metaErr && Array.isArray(metaRows) && metaRows.length > 0) {
              // Optional pre-filter: query documents by sender/receiver/date
              let filteredIds = null;
              if (filters?.sender || filters?.receiver || filters?.dateRange) {
                let q = db.from('documents').select('id').eq('org_id', orgId);
                if (filters.sender) q = q.ilike('sender', `%${filters.sender}%`);
                if (filters.receiver) q = q.ilike('receiver', `%${filters.receiver}%`);
                if (filters.dateRange?.start) q = q.gte('document_date', filters.dateRange.start);
                if (filters.dateRange?.end) q = q.lte('document_date', filters.dateRange.end);
                const { data: idsRows } = await q;
                filteredIds = new Set((idsRows || []).map(r => r.id));
              }

              // Group meta results per doc and intersect with filter ids if present
              const byDoc = new Map();
              for (const r of metaRows) {
                if (filteredIds && !filteredIds.has(r.doc_id)) continue;
                const arr = byDoc.get(r.doc_id) || [];
                arr.push(r);
                byDoc.set(r.doc_id, arr);
              }
              const docIds = Array.from(byDoc.keys()).slice(0, 20);
              const { data: docDetails } = await db
                .from('documents')
                .select('id, title, filename, subject, sender, receiver, document_date, category, type')
                .eq('org_id', orgId)
                .in('id', docIds);
              const docMap = new Map((docDetails || []).map(d => [d.id, d]));
              documents = docIds.map(id => {
                const doc = docMap.get(id) || { id };
                const lines = (byDoc.get(id) || []).slice(0, 6).map(f => `${f.field_type}: ${f.field_value || ''}`);
                return {
                  id,
                  title: doc.title || doc.filename || 'Untitled',
                  name: doc.title || doc.filename || 'Untitled',
                  documentDate: doc.document_date,
                  sender: doc.sender,
                  receiver: doc.receiver,
                  documentType: doc.type,
                  category: doc.category,
                  content: lines.join('\n')
                };
              });
              // Rerank strictly based on metadata snippets
              try {
                const before = documents.length;
                documents = await rerankCandidates(question, plan.entities, documents, 8);
                req.log.info({ before, after: documents.length }, 'Metadata-only rerank');
              } catch {}
            }
          }
        } else {
          const { hybridSearch } = await import('../lib/metadata-embeddings.js');

          // First attempt: Direct search
          // Try to resolve a referential follow-up before broad search
          async function resolveReferDocFromConversation() {
            try {
              // Prefer explicit memory from client
              let ids = Array.isArray(userMemory?.lastListDocIds) ? userMemory.lastListDocIds : [];
              if (ids && ids.length > 0) return ids[0];
              // Fallback: scan last assistant message for citations or a listed title
              for (let i = conversation.length - 1; i >= 0; i--) {
                const m = conversation[i];
                if (m?.role !== 'assistant') continue;
                if (Array.isArray(m.citations) && m.citations.length > 0) {
                  const id = m.citations[0]?.docId; if (id) return id;
                }
                // Attempt to extract a listed title: lines starting with "1. Title"
                const content = String(m.content || '');
                const m1 = content.match(/^[\s>*-]*\s*1\.?\s+(.+)$/m);
                if (m1 && m1[1]) {
                  const titleGuess = m1[1].trim();
                  // Try to find a document with a similar title/filename
                  const { data: guess } = await db
                    .from('documents')
                    .select('id, title, filename')
                    .eq('org_id', orgId)
                    .ilike('title', `%${titleGuess.slice(0, 60)}%`)
                    .limit(1);
                  if (Array.isArray(guess) && guess[0]?.id) return guess[0].id;
                }
              }
            } catch {}
            return null;
          }

          const referDocId = await resolveReferDocFromConversation();
          if (referDocId) {
            // Hard-focus on the referenced doc and enrich; skip hybrid search
            const { data: one } = await db
              .from('documents')
              .select('id, title, filename, subject, sender, receiver, document_date, category, type')
              .eq('org_id', orgId)
              .eq('id', referDocId)
              .single();
            if (one) {
              let snippet = '';
              try {
                const embedding = await generateEmbedding(question);
                if (embedding) {
                  const { data: chunks } = await db.rpc('match_doc_chunks', {
                    p_org_id: orgId,
                    p_query_embedding: embedding,
                    p_match_count: 50,
                    p_similarity_threshold: 0.2,
                  });
                  const docChunks = (chunks || []).filter(c => c.doc_id === referDocId).slice(0, 5);
                  snippet = docChunks.map(c => String(c.content || '').trim()).filter(Boolean).join('\n---\n');
                }
              } catch {}
              documents = [{
                id: one.id,
                title: one.title || one.filename || 'Untitled',
                name: one.title || one.filename || 'Untitled',
                content: snippet || one.subject || one.title || '',
                documentDate: one.document_date,
                sender: one.sender,
                receiver: one.receiver,
                documentType: one.type,
                category: one.category
              }];
            }
          }

          // If no referenced doc was resolved, fall back to hybrid search
          let searchResults = documents.length === 0
            ? await hybridSearch(db, orgId, question, { limit: 50, threshold: 0.3 })
            : [];
          
          // If no results found, try with expanded terms
          if (!searchResults || searchResults.length === 0) {
            console.log('🔍 No results for direct search, trying expanded terms');
            
            // Expand common terms
            let expandedQuestion = question;
            if (question.toLowerCase().includes('bill')) {
              expandedQuestion = question + ' invoice receipt payment utility electricity water phone internet service';
            } else if (question.toLowerCase().includes('contract')) {
              expandedQuestion = question + ' agreement legal document';
            } else if (question.toLowerCase().includes('invoice')) {
              expandedQuestion = question + ' bill receipt payment';
            }
            
            searchResults = await hybridSearch(db, orgId, expandedQuestion, { limit: 50, threshold: 0.15 });
          }
          
          // If still no results, get all documents as fallback
          if (!searchResults || searchResults.length === 0) {
            console.log('🔍 No search results found, retrieving all documents as fallback');
            const { data: allDocs, error: allDocsError } = await db
              .from('documents')
              .select('id, title, filename, subject, sender, receiver, document_date, category, type, description')
              .eq('org_id', orgId)
              .neq('type', 'folder')
              .order('uploaded_at', { ascending: false })
              .limit(50);
              
            if (!allDocsError && allDocs && allDocs.length > 0) {
              // Convert to search results format
              searchResults = allDocs.map(doc => ({
                doc_id: doc.id,
                similarity: 0.1, // Low similarity since these are all docs
                source: 'all_documents_fallback'
              }));
              console.log(`📋 Retrieved ${allDocs.length} documents as fallback`);
            }
          }
          
          if (searchResults && searchResults.length > 0) {
            // Optional: narrow to a specific doc if the user referred to an ordinal like "first/second/that"
            const referDocId = (() => {
              try {
                // Prefer explicit memory from client; fallback to last assistant citations in conversation
                let list = Array.isArray(userMemory?.lastListDocIds) ? userMemory.lastListDocIds : [];
                if (!list || list.length === 0) {
                  for (let i = conversation.length - 1; i >= 0; i--) {
                    const m = conversation[i];
                    if (m?.role === 'assistant' && Array.isArray(m.citations) && m.citations.length > 0) {
                      list = m.citations.map(c => c.docId).filter(Boolean);
                      if (list.length > 0) break;
                    }
                  }
                }
                if (list.length === 0) return null;
                const s = String(question || '').toLowerCase();
                const ordMap = new Map([
                  ['first', 0], ['1st', 0],
                  ['second', 1], ['2nd', 1],
                  ['third', 2], ['3rd', 2],
                  ['fourth', 3], ['4th', 3]
                ]);
                for (const [k, idx] of ordMap.entries()) {
                  if (s.includes(k)) return list[idx] || list[0];
                }
                if (/(that|it|the\s+first\s+one|the\s+top\s+one)/.test(s)) return list[0];
                return null;
              } catch { return null; }
            })();
            // Get document details for the results
            let docIds = [...new Set(searchResults.map(r => r.doc_id))].slice(0, 20);
            let docQuery = db
              .from('documents')
              .select('id, title, filename, subject, sender, receiver, document_date, category, type, description')
              .eq('org_id', orgId)
              .in('id', docIds);
            // Apply structured type/category filters where possible
            if (plan.typeFilters.length > 0) {
              const ors = plan.typeFilters.map(t => `type.ilike.%${t}%`).join(',');
              if (ors) docQuery = docQuery.or(ors);
            }
            let { data: docDetails, error: docError } = await docQuery;
            // If filters were too strict and returned nothing, retry without filters
            if (!docError && (!docDetails || docDetails.length === 0) && plan.typeFilters.length > 0) {
              const retryQuery = db
                .from('documents')
                .select('id, title, filename, subject, sender, receiver, document_date, category, type, description')
                .eq('org_id', orgId)
                .in('id', docIds);
              const retry = await retryQuery;
              docDetails = retry.data;
              docError = retry.error;
              req.log.info({ typeFilters: plan.typeFilters }, 'Type filters yielded no docs; retried without filters');
            }
            
            if (!docError && docDetails) {
              // Create a map for quick lookup
              const docMap = new Map(docDetails.map(doc => [doc.id, doc]));
              
              // Start with metadata-only docs (will enrich with content snippets below)
              documents = searchResults
                .map(result => {
                  const doc = docMap.get(result.doc_id);
                  if (!doc) return null;
                  // Exclude folders from search results
                  if (doc.type === 'folder') return null;
                  return {
                    id: doc.id,
                    title: doc.title || doc.filename || 'Untitled',
                    name: doc.title || doc.filename || 'Untitled',
                    content: '', // fill with snippet content below
                    documentDate: doc.document_date,
                    sender: doc.sender,
                    receiver: doc.receiver,
                    documentType: doc.type,
                    category: doc.category,
                    tags: doc.tags || []
                  };
                })
                .filter(Boolean);

              // Enrich with semantic content snippets via match_doc_chunks
              try {
                const embedding = await generateEmbedding(question);
                if (embedding) {
                  const { data: chunks, error: chunkErr } = await db.rpc('match_doc_chunks', {
                    p_org_id: orgId,
                    p_query_embedding: embedding,
                    p_match_count: 60,
                    p_similarity_threshold: plan.typeFilters.length > 0 ? 0.25 : 0.2,
                  });
                  if (!chunkErr && Array.isArray(chunks)) {
                    const allowed = new Set(docIds);
                    const byDoc = new Map();
                    for (const ch of chunks) {
                      if (!allowed.has(ch.doc_id)) continue;
                      const arr = byDoc.get(ch.doc_id) || [];
                      arr.push(ch);
                      byDoc.set(ch.doc_id, arr);
                    }
                    // Map into top snippets per doc (limit 3), prefer entity/type keywords
                    const keywords = new Set([...plan.typeFilters, ...plan.boostTerms].map(s => s.toLowerCase()));
                    let narrowed = documents;
                    if (referDocId) {
                      const only = narrowed.find(d => d.id === referDocId);
                      if (only) narrowed = [only];
                    }
                    documents = narrowed.map(d => {
                      let list = (byDoc.get(d.id) || [])
                        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
                      if (keywords.size > 0) {
                        const pref = list.filter(c => {
                          const txt = String(c.content || '').toLowerCase();
                          for (const k of keywords) { if (txt.includes(k)) return true; }
                          return false;
                        });
                        if (pref.length > 0) list = pref.concat(list.filter(x => !pref.includes(x)));
                      }
                      list = list.slice(0, 3);
                      const parts = [];
                      const seen = new Set();
                      for (const c of list) {
                        const txt = String(c.content || '').trim();
                        if (txt && !seen.has(txt)) { parts.push(txt); seen.add(txt); }
                      }
                      const merged = parts.join('\n---\n');
                      return { ...d, content: merged || d.content };
                    });
                  }
                }
              } catch (enrichErr) {
                req.log.warn({ err: enrichErr }, 'Failed to enrich docs with content snippets');
              }

              // Entity-aware LLM rerank to tighten top candidates
              try {
                const before = documents.length;
                documents = await rerankCandidates(question, plan.entities, documents, 5);
                req.log.info({ before, after: documents.length }, 'Rerank filtered candidates');
              } catch (e) {
                req.log.warn({ err: e }, 'Rerank failed; continuing');
              }
            }
          } else {
            console.log('🔍 No relevant results found for query:', question);
          }
        }
        // Close outer try after finishing if/else retrieval block
      } catch (searchError) {
        console.warn('Document retrieval failed, continuing with empty document set:', searchError);
        documents = [];
      }
      
      // Use Enhanced Orchestrator for processing
      console.log('🤖 Processing with Enhanced Orchestrator');
      
      const orchestrator = new EnhancedAgentOrchestrator();
      let agentResponse;
      
      try {
        agentResponse = await orchestrator.processWithCoordination(
          db, 
          question, 
          documents, 
          conversation,
          routingResult,
          { perAgentTimeoutMs: 8000, overallTimeoutMs: 15000, secondaryMax: 2 }
        );
      } catch (error) {
        console.error('Enhanced orchestration failed:', error);
        
        // Simple fallback
        agentResponse = {
          answer: 'I encountered an error while processing your request. Please try rephrasing your question or try again later.',
          confidence: 0.1,
          citations: [],
          agentType: 'error',
          agentName: 'Error Handler'
        };
      }
      
      // Return consolidated JSON response with enhanced information
      return {
        ...agentResponse,
        agentType: agentResponse.agentType || routingResult.agentType,
        agentName: agentResponse.agentName || routingResult.agentName,
        intent: routingResult.intent,
        confidence: agentResponse.confidence || routingResult.confidence,
        expandedQuery: routingResult.expandedQuery,
        entities: routingResult.entities,
        // Include additional information from coordinated processing
        agentInsights: agentResponse.agentInsights,
        consensusResult: agentResponse.consensusResult,
        executionTrace: agentResponse.executionTrace
      };
      
    } catch (error) {
      console.error('Agent processing error:', error);
      
      // Handle rate limit errors specifically
      let errorMessage = 'An error occurred while processing your request. Please try again.';
      let errorCode = 'AGENT_PROCESSING_ERROR';
      
      if (error.message && error.message.includes('rate limit')) {
        errorMessage = 'The AI service is currently busy due to rate limits. Please wait a moment and try again.';
        errorCode = 'RATE_LIMIT_EXCEEDED';
      } else if (error.message && error.message.includes('quota')) {
        errorMessage = 'The AI service has reached its quota limit. Please try again later.';
        errorCode = 'QUOTA_EXCEEDED';
      }
      
      return {
        answer: errorMessage,
        citations: [],
        agentType: 'error',
        agentName: 'Error Handler',
        intent: 'Error',
        confidence: 0.1,
        expandedQuery: { original: question, expanded: question, terms: [question] },
        entities: [],
        agentInsights: [],
        consensusResult: null,
        executionTrace: [],
        errorCode: errorCode
      };
    }
  });

  console.log('✅ Test agent routes registered');
}

// Build allowed doc ids based on context scoping
async function computeAllowedDocIds(db, orgId, context) {
  try {
    if (!context || !context.scope || context.scope === 'org') return [];
    if (context.scope === 'doc') {
      if (!context.docId) return [];
      const ids = new Set([context.docId]);
      // include versions
      if (context.includeVersions) {
        try {
          const { data: d } = await db
            .from('documents')
            .select('version_group_id')
            .eq('org_id', orgId)
            .eq('id', context.docId)
            .maybeSingle();
          const vg = d?.version_group_id;
          if (vg) {
            const { data: vs } = await db
              .from('documents')
              .select('id')
              .eq('org_id', orgId)
              .eq('version_group_id', vg);
            (vs || []).forEach(r => ids.add(r.id));
          }
        } catch {}
      }
      // include linked (both directions)
      if (context.includeLinked) {
        try {
          const { data: out } = await db.from('document_links').select('linked_doc_id').eq('org_id', orgId).eq('doc_id', context.docId);
          const { data: inc } = await db.from('document_links').select('doc_id').eq('org_id', orgId).eq('linked_doc_id', context.docId);
          (out || []).forEach(r => r?.linked_doc_id && ids.add(r.linked_doc_id));
          (inc || []).forEach(r => r?.doc_id && ids.add(r.doc_id));
        } catch {}
      }
      return Array.from(ids);
    }
    if (context.scope === 'folder') {
      const path = Array.isArray(context.folderPath) ? context.folderPath : [];
      if (path.length === 0) return [];
      // Prefer server-side RPC if available
      let ids = new Set();
      try {
        const { data: list } = await db.rpc('list_docs_in_subtree', { p_org_id: orgId, p_path: path });
        if (Array.isArray(list)) {
          list.forEach(r => r?.id && ids.add(r.id));
        }
      } catch {}
      if (ids.size === 0) {
        // Fallback: fetch ids + folder_path and filter in-process by prefix
        const { data: rows } = await db
          .from('documents')
          .select('id, folder_path, type')
          .eq('org_id', orgId);
        const subtree = (rows || []).filter((row) => {
          const fp = row.folder_path || [];
          if (!Array.isArray(fp)) return false;
          if (fp.length < path.length) return false;
          for (let i = 0; i < path.length; i++) {
            if (fp[i] !== path[i]) return false;
          }
          return row.type !== 'folder';
        });
        ids = new Set(subtree.map(r => r.id));
      }
      if (context.includeLinked && ids.size) {
        try {
          const arr = Array.from(ids);
          const { data: out } = await db.from('document_links').select('doc_id, linked_doc_id').eq('org_id', orgId).in('doc_id', arr);
          const { data: inc } = await db.from('document_links').select('doc_id, linked_doc_id').eq('org_id', orgId).in('linked_doc_id', arr);
          (out || []).forEach(r => r?.linked_doc_id && ids.add(r.linked_doc_id));
          (inc || []).forEach(r => r?.doc_id && ids.add(r.doc_id));
        } catch {}
      }
      return Array.from(ids);
    }
    return [];
  } catch {
    return [];
  }
}

// Helper function to extract numerical entities from document content
function extractNumericalEntities(content) {
  if (!content || typeof content !== 'string') return { currency: [], numbers: [] };
  
  // Extract currency values (₹, Rs., rupees)
  const currencyRegex = /(?:₹|Rs\.?|rupees)\s*([0-9,]+\.?[0-9]*)/gi;
  const currencyMatches = content.match(currencyRegex) || [];
  
  // Extract other numerical values
  const numberRegex = /\b[0-9,]+\.?[0-9]*\b/g;
  const numberMatches = content.match(numberRegex) || [];
  
  return {
    currency: currencyMatches.map(match => match.replace(/[^0-9,₹.]/g, '')),
    numbers: numberMatches
  };
}

// Helper function to check if question is asking about numerical values
function isNumericalQuery(question) {
  if (!question || typeof question !== 'string') return false;
  
  const lowerQuestion = question.toLowerCase();
  const numericalKeywords = ['value', 'amount', 'total', 'worth', 'cost', 'price', '₹', 'rs', 'rupees'];
  
  return numericalKeywords.some(keyword => lowerQuestion.includes(keyword));
}

// Helper function to find chunks containing specific numerical values
function findChunksWithNumericalValues(chunks, numericalEntities) {
  if (!chunks || !Array.isArray(chunks) || !numericalEntities) return [];
  
  const { currency, numbers } = numericalEntities;
  const allValues = [...currency, ...numbers];
  
  if (allValues.length === 0) return [];
  
  return chunks.filter(chunk => {
    const content = (chunk.content || '').toString().toLowerCase();
    return allValues.some(value => {
      // Remove formatting for comparison
      const cleanValue = value.toString().replace(/[^0-9.]/g, '');
      return content.includes(cleanValue);
    });
  });
}

// Helper function to ensure active member
async function ensureActiveMember(req) {
  const db = req.supabase;
  const orgId = req.headers['x-org-id'] || req.params?.orgId;
  if (!orgId) {
    const err = new Error('Missing org id');
    err.statusCode = 400;
    throw err;
  }
  const userId = req.user?.sub;
  if (!userId) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const { data, error } = await db
    .from('organization_users')
    .select('role, created_at, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    const err = new Error('Membership expired');
    err.statusCode = 403;
    throw err;
  }
  return String(orgId);
}
  console.log('🔍 Processing metadata query');
  
  try {
    // Import the hybrid search function
    const { hybridSearch } = await import('../lib/metadata-embeddings.js');
    
    // Use hybrid search combining metadata embeddings, content embeddings, and keyword search
    console.log('🔍 Using hybrid search for metadata query:', question);
    
    const searchResults = await hybridSearch(db, orgId, question, { limit: 20, threshold: 0.3 });
    
    if (!searchResults || searchResults.length === 0) {
      return {
        answer: "I couldn't find any documents matching your query using semantic search.",
        citations: []
      };
    }
    
    // Get document details for the results
    const docIds = [...new Set(searchResults.map(r => r.doc_id))];
    const { data: documents, error: docError } = await db
      .from('documents')
      .select('id, title, filename, subject, sender, receiver, document_date, category, type')
      .eq('org_id', orgId)
      .in('id', docIds);
      
    if (docError) throw docError;
    
    if (!documents || documents.length === 0) {
      return {
        answer: 'I couldn\'t find any documents matching your query.',
        citations: []
      };
    }
    
    // Create a map for quick lookup
    const docMap = new Map(documents.map(doc => [doc.id, doc]));
    
    // Format the results with scores
    const scoredDocuments = searchResults
      .map(result => {
        const doc = docMap.get(result.doc_id);
        if (!doc) return null;
        // Exclude folders from search results
        if (doc.type === 'folder') return null;
        return {
          ...doc,
          score: result.score,
          sources: result.sources
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    
    // Limit documents for display consistency
    const displayDocuments = scoredDocuments.slice(0, 3);
    
    // Generate a natural language response with semantic awareness
    const responseText = `I found ${displayDocuments.length} semantically relevant documents for your query. Here are the best matches:

${displayDocuments.map(doc => `- ${doc.title || doc.filename || 'Untitled'} (${doc.type || 'Document'}) - Score: ${(doc.score * 100).toFixed(1)}%`).join('\n')}

These results are based on semantic similarity to your query terms using metadata embeddings.`;
    
    // Create citations with semantic scores
    const citations = displayDocuments.map(doc => ({
      docId: doc.id,
      snippet: `${doc.title || doc.filename || 'Untitled'} (${doc.type || 'Document'}) - Semantic Score: ${(doc.score * 100).toFixed(1)}%`,
      docName: doc.title || doc.filename || 'Untitled'
    }));
    
    return {
      answer: responseText,
      citations
    };
  } catch (error) {
    console.error('Hybrid search failed, falling back to basic search:', error);
    
    // Fallback to the original basic search implementation
    // Use extracted entities to refine search
    const entities = routingResult.entities || [];
    const expandedQuery = routingResult.expandedQuery?.expanded || question;
    
    // Build search conditions based on entities and expanded query
    let conditions = [];
    
    // Add conditions for title-related entities
    const titleEntities = entities.filter(e => e.type === 'title');
    if (titleEntities.length > 0) {
      titleEntities.forEach(entity => {
        conditions.push(`title.ilike.%${entity.value}%`);
        conditions.push(`filename.ilike.%${entity.value}%`);
      });
    }
    
    // Add conditions for document type entities
    const docTypeEntities = entities.filter(e => e.type === 'document_type');
    if (docTypeEntities.length > 0) {
      docTypeEntities.forEach(entity => {
        const typeValue = entity.value.toLowerCase();
        // Map common document type terms to actual document types
        const typeMapping = {
          'invoice': 'Invoice',
          'bill': 'Invoice',
          'receipt': 'Invoice',
          'payment': 'Invoice',
          'budget': 'Financial',
          'financial': 'Financial',
          'contract': 'Contract',
          'agreement': 'Contract',
          'legal': 'Legal',
          'resume': 'Resume',
          'cv': 'Resume',
          'report': 'Report',
          'correspondence': 'Correspondence',
          'letter': 'Correspondence',
          'email': 'Correspondence',
          'memo': 'Correspondence',
          'document': 'PDF',
          'documents': 'PDF',
          'paper': 'PDF',
          'pdf': 'PDF'
        };
        
        const mappedType = typeMapping[typeValue];
        if (mappedType) {
          conditions.push(`type.eq.${mappedType}`);
        }
      });
    }
    
    // Add conditions for category entities
    const categoryEntities = entities.filter(e => e.type === 'category');
    if (categoryEntities.length > 0) {
      categoryEntities.forEach(entity => {
        conditions.push(`category.ilike.%${entity.value}%`);
        // Also search in subject and title for category-like terms
        conditions.push(`subject.ilike.%${entity.value}%`);
        conditions.push(`title.ilike.%${entity.value}%`);
      });
    }
    
    // Add conditions for topic entities
    const topicEntities = entities.filter(e => e.type === 'topic');
    if (topicEntities.length > 0) {
      topicEntities.forEach(entity => {
        // Search in title, subject, and keywords for topic terms
        conditions.push(`title.ilike.%${entity.value}%`);
        conditions.push(`subject.ilike.%${entity.value}%`);
        // Temporarily removing keywords search to avoid syntax issues
      });
    }
    
    // Add conditions for date entities
    const dateEntities = entities.filter(e => e.type === 'date');
    if (dateEntities.length > 0) {
      dateEntities.forEach(entity => {
        // For date entities, we need to use proper date comparison rather than LIKE
        // Convert the entity value to a date range if it's a relative date like "last month"
        const dateValue = entity.value.toLowerCase();
        
        if (dateValue === 'last month') {
          // Get the first day of last month and last day of last month
          const now = new Date();
          const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const firstDay = lastMonth.toISOString().split('T')[0];
          const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
          conditions.push(`document_date.gte.${firstDay}`);
          conditions.push(`document_date.lte.${lastDay}`);
        } else if (dateValue === 'this month') {
          // Get the first day of this month and today
          const now = new Date();
          const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
          const lastDay = now.toISOString().split('T')[0];
          conditions.push(`document_date.gte.${firstDay}`);
          conditions.push(`document_date.lte.${lastDay}`);
        } else if (dateValue === 'last week') {
          // Get the Monday of last week and Sunday of last week
          const now = new Date();
          const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
          const mondayOfLastWeek = new Date(now);
          mondayOfLastWeek.setDate(now.getDate() - dayOfWeek - 7);
          const sundayOfLastWeek = new Date(mondayOfLastWeek);
          sundayOfLastWeek.setDate(mondayOfLastWeek.getDate() + 6);
          
          const firstDay = mondayOfLastWeek.toISOString().split('T')[0];
          const lastDay = sundayOfLastWeek.toISOString().split('T')[0];
          conditions.push(`document_date.gte.${firstDay}`);
          conditions.push(`document_date.lte.${lastDay}`);
        } else {
          // Try to parse the date value as a specific date
          try {
            const parsedDate = new Date(dateValue);
            if (!isNaN(parsedDate.getTime())) {
              // If it's a valid date, search for documents on that specific date
              const isoDate = parsedDate.toISOString().split('T')[0];
              conditions.push(`document_date.eq.${isoDate}`);
            } else {
              // For partial date matches (e.g. "2023", "january 2023"), use LIKE on the string representation
              conditions.push(`document_date::text.ilike.%${dateValue}%`);
            }
          } catch (parseError) {
            // If date parsing fails, fall back to text search
            conditions.push(`document_date::text.ilike.%${dateValue}%`);
          }
        }
      });
    }
    
    // Fallback to expanded query search
    if (conditions.length === 0) {
      const terms = expandedQuery.split(/\s+/).filter(term => term.length > 2);
      terms.forEach(term => {
        conditions.push(`title.ilike.%${term}%`);
        conditions.push(`subject.ilike.%${term}%`);
        conditions.push(`sender.ilike.%${term}%`);
        conditions.push(`receiver.ilike.%${term}%`);
        conditions.push(`category.ilike.%${term}%`);
        conditions.push(`type.ilike.%${term}%`);
        // Temporarily removing keywords search to avoid syntax issues
      });
    }
    
    // Remove any duplicate conditions
    conditions = [...new Set(conditions)];
    
    // Construct the OR query
    const orCondition = conditions.join(',');
    
    // Log the condition for debugging
    console.log('🔍 Metadata search conditions (fallback):', orCondition);
    
    // Search for documents based on metadata
    const { data, error: searchError } = await db
      .from('documents')
      .select('id, title, filename, subject, sender, receiver, document_date, category, type, keywords')
      .eq('org_id', orgId)
      .or(orCondition)
      .order('uploaded_at', { ascending: false })
      .limit(20);
      
    if (searchError) throw searchError;
    
    if (!data || data.length === 0) {
      return {
        answer: 'I couldn\'t find any documents matching your query.',
        citations: []
      };
    }
    
    // Format the results
    const documents = data.map(doc => ({
      id: doc.id,
      title: doc.title || doc.filename || 'Untitled',
      subject: doc.subject,
      sender: doc.sender,
      receiver: doc.receiver,
      date: doc.document_date,
      category: doc.category,
      type: doc.type
    }));
    
    // Generate a natural language response
    const responseText = `I found ${documents.length} documents that match your query. Here are the key details:

${documents.slice(0, 5).map(doc => `- ${doc.title} (${doc.type}) - ${doc.category || 'Uncategorized'} - ${doc.date || 'Date unknown'}`).join('\n')}

Would you like more details about any specific document?`;
    
    // Create citations
    const citations = documents.slice(0, 3).map(doc => ({
      docId: doc.id,
      snippet: `${doc.title} (${doc.type}) - ${doc.category}`,
      docName: doc.title
    }));
    
    return {
      answer: responseText,
      citations
    };
  }
}

// Enhanced content query processing with better RAG and entity awareness
async function processContentQuery(db, orgId, userId, question, conversation, userMemory, routingResult) {
  console.log('📄 Processing content query');
  
  // Use extracted entities and expanded query for better retrieval
  const entities = routingResult.entities || [];
  const expandedQuery = routingResult.expandedQuery?.expanded || question;
  
  // 1. Embed expanded query for semantic search
  const embedding = await embedQuery(expandedQuery).catch(() => null);
  
  let relevantChunks = [];
  if (embedding) {
    // Semantic search with expanded query
    console.log('🔍 Performing semantic search');
    const { data, error } = await db.rpc('match_doc_chunks', {
      p_org_id: orgId,
      p_query_embedding: embedding,
      p_match_count: 24,
      p_similarity_threshold: 0
    });
    
    if (!error && Array.isArray(data)) {
      relevantChunks = data;
    }
  }
  
  if (relevantChunks.length === 0) {
    // Fallback to lexical search with expanded query
    console.log('🔍 Fallback to lexical search');
    const terms = expandedQuery.split(/\s+/).filter(term => term.length > 2);
    const conditions = terms.map(term => [
      `title.ilike.%${term}%`,
      `subject.ilike.%${term}%`,
      `sender.ilike.%${term}%`,
      `receiver.ilike.%${term}%`,
      `type.ilike.%${term}%`,
      `category.ilike.%${term}%`
    ]).flat();
    
    if (conditions.length > 0) {
      const orCondition = conditions.join(',');
      const { data, error } = await db
        .from('documents')
        .select('id, title, filename, subject, sender, receiver, uploaded_at, type, category, document_date')
        .eq('org_id', orgId)
        .or(orCondition)
        .order('uploaded_at', { ascending: false })
        .limit(12);
        
      if (!error) {
        relevantChunks = (data || []).map(d => ({
          doc_id: d.id,
          content: [d.title, d.subject, d.sender, d.receiver, d.type, d.category, d.document_date].filter(Boolean).join(' — ').slice(0, 500),
          similarity: 0.3,
          title: d.title || d.filename || 'Untitled',
          filename: d.filename,
          doc_type: d.type || null,
          uploaded_at: d.uploaded_at
        }));
      }
    }
  }
  
  if (relevantChunks.length === 0) {
    return {
      answer: 'I couldn\'t find any relevant documents to answer your question.',
      citations: []
    };
  }
  
  // Aggregate by document and select top snippets
  const byDoc = new Map();
  for (const r of relevantChunks) {
    const id = r.doc_id;
    const entry = byDoc.get(id) || { id, title: r.title || r.filename || 'Untitled', best: -1, snippets: [] };
    entry.best = Math.max(entry.best, Number(r.similarity || 0));
    if (entry.snippets.length < 3) entry.snippets.push(String(r.content || '').slice(0, 500));
    byDoc.set(id, entry);
  }
  const docs = Array.from(byDoc.values()).sort((a,b) => b.best - a.best).slice(0, 10);
  const contextBlocks = docs.map((d, i) => `[#${i}] ${d.title}\n${d.snippets.join('\n---\n')}`).join('\n\n');
  
  // Generate answer with context
  const responseText = `Based on the documents I found, here's what I can tell you about "${question}":

${contextBlocks.substring(0, 1000)}...

This is a summary based on the most relevant documents. Would you like me to elaborate on any specific aspect?`;
  
  // Create citations
  const topByDoc = new Map();
  for (const r of relevantChunks) {
    const id = r.doc_id;
    const score = Number(r.similarity || 0);
    const prev = topByDoc.get(id);
    if (!prev || score > prev) topByDoc.set(id, { score, page: (typeof r.page === 'number' ? r.page : null), snippet: String(r.content || '').slice(0, 500) });
  }
  
  const citations = Array.from(byDoc.values()).slice(0, 3).map((d) => {
    const best = topByDoc.get(d.id);
    return { docId: d.id, page: best?.page ?? null, snippet: best?.snippet || (d.snippets[0] || ''), docName: d.title };
  });
  
  return {
    answer: responseText,
    citations
  };
}

// Placeholder functions for other agent types (to be implemented)

// Enhanced casual conversation processing
async function processCasualQuery(question, conversation, routingResult) {
  console.log('💬 Processing casual query');
  
  // Simple pattern matching for common greetings and casual conversation
  const q = question.toLowerCase().trim();
  
  // Greetings
  if (/(^|\b)(hi|hello|hey|what's up|whats up|howdy|how are you|how're you|how do you do|how's it going)\b/i.test(q)) {
    return {
      answer: "Hello there! I'm your document assistant. I can help you find, analyze, and understand your documents. What would you like to know about your documents?",
      citations: []
    };
  }
  
  // How are you
  if (/(how are you|how're you|how do you do|how's it going)/.test(q)) {
    return {
      answer: "I'm doing great, thank you for asking! I'm here and ready to help you with your document-related questions. What can I assist you with today?",
      citations: []
    };
  }
  
  // Thank you
  if (/(thank you|thanks|thx|thankyou)/.test(q)) {
    return {
      answer: "You're welcome! I'm happy to help. Is there anything else about your documents you'd like to explore?",
      citations: []
    };
  }
  
  // Goodbye
  if (/(bye|goodbye|see you|later|farewell)/.test(q)) {
    return {
      answer: "Goodbye! Feel free to come back anytime if you have more document questions. Have a great day!",
      citations: []
    };
  }
  
  // General questions not about documents
  if (/(what can you do|what are you for|what is this|what is this for)/.test(q)) {
    return {
      answer: "I'm an intelligent document assistant designed to help you work with your documents. I can:\n\n" +
             "• Find specific documents by title, sender, date, or content\n" +
             "• Answer questions about document contents\n" +
             "• Extract key information from documents\n" +
             "• Compare similar documents\n" +
             "• Analyze financial or legal documents\n" +
             "• Help you understand complex documents\n\n" +
             "What would you like to do with your documents?",
      citations: []
    };
  }
  
  // Default casual response with document context
  return {
    answer: "I'm here to help you with your documents. You can ask me questions like:\n\n" +
           "• \"Find documents from last month\"\n" +
           "• \"What's in the contract with Microsoft?\"\n" +
           "• \"Show me invoices from ABC Company\"\n" +
           "• \"Compare the Q1 and Q2 reports\"\n\n" +
           "What would you like to know about your documents?",
    citations: []
  };
}

// Helper function to embed query (copied from routes.js)
async function embedQuery(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings error: ${res.status} ${errTxt}`);
  }
  const data = await res.json();
  const emb = data?.data?.[0]?.embedding;
  return Array.isArray(emb) ? emb : null;
}
