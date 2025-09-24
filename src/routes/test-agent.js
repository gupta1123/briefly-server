// Test Agent Routes - Simplified REST-based implementation
// This file implements the simplified agentic chat functionality

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
  console.log('🧪 Registering simplified test agent routes...');

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

    const { question, conversation = [], memory: userMemory = {}, context = { scope: 'org' }, filters = {}, strictCitations } = Schema.parse(req.body || {});

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

      // If AI is degraded, return degraded response
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
                .slice(0, 3);
              const content = list.map(c => c.content).join(' ... ');
              documents.push({
                id: d.id,
                title: d.title,
                filename: d.filename,
                subject: d.subject,
                sender: d.sender,
                receiver: d.receiver,
                documentDate: d.document_date,
                category: d.category,
                documentType: d.type,
                content: content || ''
              });
            }
          }
        } else {
          // Standard retrieval for org/folder scope
            const { data: docDetails } = await db
              .from('documents')
              .select('id, title, filename, subject, sender, receiver, document_date, category, type')
              .eq('org_id', orgId)
            .in('id', Array.from(allowedDocIds))
            .limit(50);
          
          if (docDetails && docDetails.length > 0) {
            // Enrich with top-matching chunks
            let byDocSnippets = new Map();
            if (queryEmbedding) {
              try {
                const { data: chunks } = await db.rpc('match_doc_chunks', {
                  p_org_id: orgId,
                  p_query_embedding: queryEmbedding,
                  p_match_count: 100,
                  p_similarity_threshold: 0.2,
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
            
            documents = [];
            for (const d of docDetails) {
              let list = (byDocSnippets.get(d.id) || [])
                .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
                .slice(0, 2);
              const content = list.map(c => c.content).join(' ... ');
              documents.push({
                id: d.id,
                title: d.title,
                filename: d.filename,
                subject: d.subject,
                sender: d.sender,
                receiver: d.receiver,
                documentDate: d.document_date,
                category: d.category,
                documentType: d.type,
                content: content || ''
              });
            }
            
            // Rerank candidates and keep the best few to reduce noise
              try {
                const before = documents.length;
              documents = await rerankCandidates(question, [], documents, 5);
              req.log && req.log.info && req.log.info({ before, after: documents.length }, 'Rerank filtered candidates');
              } catch (e) {
              req.log && req.log.warn ? req.log.warn({ err: e }, 'Rerank failed; continuing') : console.warn('Rerank failed', e);
              }
            }
          }
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
        agentType: agentResponse.agentType || routingResult?.agentType || 'content',
        agentName: agentResponse.agentName || routingResult?.agentName || 'Content Agent',
        intent: routingResult?.intent || 'ContentQA',
        confidence: agentResponse.confidence || routingResult?.confidence || 0.5,
        expandedQuery: routingResult?.expandedQuery || { original: question, expanded: question, terms: [question] },
        entities: routingResult?.entities || [],
        agentInsights: agentResponse.agentInsights || [],
        consensusResult: agentResponse.consensusResult || null,
        executionTrace: agentResponse.executionTrace || []
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

  console.log('✅ Simplified test agent routes registered');
}

// Build allowed doc ids based on context scoping
async function computeAllowedDocIds(db, orgId, context) {
  try {
    if (context?.scope === 'doc' && context.docId) {
      return [context.docId];
    } else if (context?.scope === 'folder' && context.folderPath) {
      const { data: docs } = await db
              .from('documents')
              .select('id')
              .eq('org_id', orgId)
        .like('folder_path', context.folderPath.join('/') + '%');
      return docs?.map(d => d.id) || [];
    } else {
      // org scope - get all docs
      const { data: docs } = await db
          .from('documents')
        .select('id')
          .eq('org_id', orgId);
      return docs?.map(d => d.id) || [];
    }
  } catch (error) {
    console.error('Error computing allowed doc IDs:', error);
    return [];
  }
}

// Helper function to detect numerical queries
function isNumericalQuery(question) {
  const q = question.toLowerCase();
  return /\b\d+\b/.test(q) && (
    q.includes('amount') || q.includes('cost') || q.includes('price') || 
    q.includes('total') || q.includes('sum') || q.includes('count') ||
    q.includes('number') || q.includes('quantity')
  );
}

// Ensure user is active member of organization
async function ensureActiveMember(req) {
  const orgId = req.params.orgId;
  const userId = req.user?.sub;
  
  if (!userId) {
    const err = new Error('Authentication required');
    err.statusCode = 401;
    throw err;
  }
  
  const { data, error } = await req.supabase
    .from('organization_users')
    .select('role, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
    
  if (error) throw error;
  if (!data) {
    const err = new Error('Not a member of this organization');
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
