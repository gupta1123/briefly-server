// Enhanced Agent Routes - Improved routing and query understanding
// This file implements the new agentic architecture with enhanced capabilities

import { z } from 'zod';
import { routeQuestion } from '../agents/ai-router.js';
import EnhancedAgentOrchestrator from '../agents/enhanced-orchestrator.js';
import { hybridSearch } from '../lib/metadata-embeddings.js';
import { generateEmbedding } from '../lib/embeddings.js';
import { rerankCandidates } from '../lib/rerank-service.js';

/**
 * Register enhanced agent routes
 * @param {Object} app - Fastify app instance
 */
export function registerAgentRoutes(app) {
  console.log('🤖 Registering enhanced agent routes...');
  
  // Enhanced chat endpoint with improved agentic capabilities
  app.post('/orgs/:orgId/chat/ask-v2', { 
    preHandler: [app.verifyAuth, app.requireIpAccess] 
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMemberAgents(req);
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

    // Prepare SSE
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    const send = (event, data) => reply.sse({ event, data: typeof data === 'string' ? data : JSON.stringify(data) });
    send('start', { ok: true });

    try {
      // Retrieve relevant documents for the query
      // Use hybrid search to get documents relevant to the question
      let documents = [];
      try {
        const searchResults = await hybridSearch(db, orgId, question, { limit: 20, threshold: 0.3 });
        if (searchResults && searchResults.length > 0) {
          // Get document details for the results
          const docIds = [...new Set(searchResults.map(r => r.doc_id))].slice(0, 10); // cap to 10 docs
          const { data: docDetails, error: docError } = await db
            .from('documents')
            .select('id, title, filename, subject, sender, receiver, document_date, category, type, description')
            .eq('org_id', orgId)
            .in('id', docIds);
            
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
                  p_match_count: 50,
                  p_similarity_threshold: 0.2,
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
                  // Map into top snippets per doc (limit 3, dedup by content)
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
              }
            } catch (enrichErr) {
              req.log && req.log.warn ? req.log.warn({ err: enrichErr }, 'Failed to enrich docs with content snippets') : console.warn('Failed to enrich docs with content snippets', enrichErr);
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

      // Use enhanced router once and pass downstream
      const routingResult = await enhancedRouteQuestion(db, orgId, question, conversation);
      
      // Send mode information with enhanced details
      send('mode', {
        mode: routingResult.agentType || 'content',
        agentType: routingResult.agentType,
        agentName: routingResult.agentName,
        intent: routingResult.intent,
        confidence: routingResult.confidence,
        expandedQuery: routingResult.expandedQuery,
        entities: routingResult.entities
      });
      
      // NEW: Use coordinated multi-agent processing instead of single agent
      send('stage', { 
        agent: 'EnhancedOrchestrator', 
        step: 'coordinated_processing',
        mode: 'multi_agent_coordination'
      });
      
      // Process with coordinated multi-agent approach
      const orchestrator = new EnhancedAgentOrchestrator();
      const agentResponse = await orchestrator.processWithCoordination(
        db, 
        question, 
        documents, 
        conversation,
        routingResult,
        { perAgentTimeoutMs: 8000, overallTimeoutMs: 15000, secondaryMax: 2 }
      );
      
      // Send final response
      send('delta', agentResponse.answer);
      send('end', {
        done: true,
        citations: agentResponse.citations || [],
        agentType: agentResponse.agentType || routingResult.agentType,
        agentName: agentResponse.agentName || routingResult.agentName,
        intent: routingResult.intent,
        confidence: agentResponse.confidence || routingResult.confidence,
        // Include additional information from coordinated processing
        agentInsights: agentResponse.agentInsights,
        consensusResult: agentResponse.consensusResult,
        executionTrace: agentResponse.executionTrace
      });
      
    } catch (error) {
      console.error('Agent processing error:', error);
      send('error', { 
        message: 'An error occurred while processing your request',
        detail: process.env.NODE_ENV === 'development' ? error.message : 'Please try again'
      });
      send('end', { done: true, citations: [] });
    }
  });

  console.log('✅ Enhanced agent routes registered');
  
  // Parallel agent execution endpoint
  app.post('/orgs/:orgId/agents/execute-parallel', { 
    preHandler: [app.verifyAuth, app.requireIpAccess] 
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMemberAgents(req);
    
    const Schema = z.object({
      agentTypes: z.array(z.string()).min(1),
      question: z.string().min(1),
      documents: z.array(z.object({
        id: z.string(),
        title: z.string().nullable(),
        name: z.string(),
        content: z.string().nullable(),
      })).optional(),
      conversation: z.array(z.object({
        role: z.enum(['user', 'assistant']).optional(),
        content: z.string().optional(),
      })).optional(),
    });
    
    const { agentTypes, question, documents = [], conversation = [] } = Schema.parse(req.body || {});
    
    try {
      const orchestrator = new EnhancedAgentOrchestrator();
      const result = await orchestrator.executeParallel(db, agentTypes, question, documents, conversation);
      
      return {
        success: true,
        results: result
      };
    } catch (error) {
      console.error('Parallel agent execution error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message
      });
    }
  });
  
  // Agent chaining endpoint
  app.post('/orgs/:orgId/agents/chain', { 
    preHandler: [app.verifyAuth, app.requireIpAccess] 
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMemberAgents(req);
    
    const Schema = z.object({
      agentSequence: z.array(z.string()).min(1),
      question: z.string().min(1),
      documents: z.array(z.object({
        id: z.string(),
        title: z.string().nullable(),
        name: z.string(),
        content: z.string().nullable(),
      })).optional(),
      conversation: z.array(z.object({
        role: z.enum(['user', 'assistant']).optional(),
        content: z.string().optional(),
      })).optional(),
    });
    
    const { agentSequence, question, documents = [], conversation = [] } = Schema.parse(req.body || {});
    
    try {
      const orchestrator = new EnhancedAgentOrchestrator();
      const result = await orchestrator.chainAgents(db, agentSequence, question, documents, conversation);
      
      return {
        success: true,
        results: result
      };
    } catch (error) {
      console.error('Agent chaining error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message
      });
    }
  });
  
  // Coordinated multi-agent processing endpoint
  app.post('/orgs/:orgId/agents/coordinate', { 
    preHandler: [app.verifyAuth, app.requireIpAccess] 
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    
    const Schema = z.object({
      question: z.string().min(1),
      documents: z.array(z.object({
        id: z.string(),
        title: z.string().nullable(),
        name: z.string(),
        content: z.string().nullable(),
      })).optional(),
      conversation: z.array(z.object({
        role: z.enum(['user', 'assistant']).optional(),
        content: z.string().optional(),
      })).optional(),
    });
    
    const { question, documents = [], conversation = [] } = Schema.parse(req.body || {});
    
    try {
      const orchestrator = new EnhancedAgentOrchestrator();
      const result = await orchestrator.processWithCoordination(db, question, documents, conversation);
      
      return {
        success: true,
        result: result
      };
    } catch (error) {
      console.error('Coordinated agent processing error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message
      });
    }
  });
}

// Local helper to ensure active membership (mirrors test-agent implementation)
async function ensureActiveMemberAgents(req) {
  const db = req.supabase;
  const orgId = req.headers['x-org-id'] || req.params?.orgId;
  if (!orgId) { const err = new Error('Missing org id'); err.statusCode = 400; throw err; }
  const userId = req.user?.sub;
  if (!userId) { const err = new Error('Unauthorized'); err.statusCode = 401; throw err; }
  const { data, error } = await db
    .from('organization_users')
    .select('role, created_at, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) { const err = new Error('Forbidden'); err.statusCode = 403; throw err; }
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) { const err = new Error('Membership expired'); err.statusCode = 403; throw err; }
  return String(orgId);
}

// Enhanced routing with better query understanding
async function enhancedRouteQuestion(db, orgId, question, conversation) {
  // Use the enhanced router (AI-powered)
  const baseRouting = await routeQuestion(question, conversation);
  
  // The AI router already includes expanded query and entities
  const expandedQuery = baseRouting.expandedQuery || { original: question, expanded: question, terms: [question] };
  const entities = baseRouting.entities || [];
  
  // Get user preferences and context
  const userPreferences = await getUserPreferences(db, orgId);
  
  // Enhance confidence with user preferences
  let enhancedConfidence = baseRouting.confidence;
  
  // Boost confidence if entities match user preferences
  if (entities.length > 0 && userPreferences.preferredSenders) {
    const senderEntities = entities.filter(e => e.type === 'name');
    if (senderEntities.some(se => userPreferences.preferredSenders.includes(se.value))) {
      enhancedConfidence = Math.min(enhancedConfidence + 0.1, 1.0);
    }
  }
  
  return {
    ...baseRouting,
    confidence: enhancedConfidence,
    expandedQuery,
    entities,
    userPreferences
  };
}

// Helper function to get user preferences
async function getUserPreferences(db, orgId) {
  // In a real implementation, this would fetch user preferences from the database
  // For now, we'll return a default structure
  return {
    preferredSenders: [],
    preferredCategories: [],
    preferredDocumentTypes: []
  };
}

// Enhanced agent processing with better orchestration
async function processWithEnhancedAgent(
  db, 
  orgId, 
  userId, 
  question, 
  conversation, 
  userMemory, 
  routingResult,
  send
) {
  send('stage', { 
    agent: routingResult.agentName || 'System', 
    step: 'processing',
    mode: routingResult.agentType || 'content'
  });
  
  // Based on the agent type, route to appropriate processing logic
  switch (routingResult.agentType) {
    case 'metadata':
      return await processMetadataQuery(db, orgId, question, conversation, userMemory, routingResult, send);
    case 'content':
      return await processContentQuery(db, orgId, userId, question, conversation, userMemory, routingResult, send);
    case 'casual':
      return await processCasualQuery(question, conversation, routingResult, send);
    default:
      // Fallback to content-based processing
      return await processContentQuery(db, orgId, userId, question, conversation, userMemory, routingResult, send);
  }
}

// Enhanced metadata query processing with entity awareness
async function processMetadataQuery(db, orgId, question, conversation, userMemory, routingResult, send) {
  send('stage', { agent: 'MetadataAgent', step: 'searching' });
  
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
  
  // Use hybrid search combining metadata embeddings, content embeddings, and keyword search
  console.log('🔍 Using hybrid search for metadata query:', question);
  
  try {
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
    const { data, error: fallbackError } = await db
      .from('documents')
      .select('id, title, filename, subject, sender, receiver, document_date, category, type, keywords')
      .eq('org_id', orgId)
      .or(orCondition)
      .order('uploaded_at', { ascending: false })
      .limit(20);
      
    if (fallbackError) throw fallbackError;
    
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
async function processContentQuery(db, orgId, userId, question, conversation, userMemory, routingResult, send) {
  send('stage', { agent: 'ContentAgent', step: 'retrieving' });
  
  // Use extracted entities and expanded query for better retrieval
  const entities = routingResult.entities || [];
  const expandedQuery = routingResult.expandedQuery?.expanded || question;
  
  // 1. Use hybrid search combining metadata embeddings, content embeddings, and keyword search
  send('stage', { agent: 'ContentAgent', step: 'hybrid_search' });
  console.log('🔍 Using hybrid search for content query:', question);
  
  try {
    const searchResults = await hybridSearch(db, orgId, expandedQuery, { limit: 24, threshold: 0.3 });
    
    if (searchResults && searchResults.length > 0) {
      // Get document details for the results
      const docIds = [...new Set(searchResults.map(r => r.doc_id))];
      const { data: documents, error: docError } = await db
        .from('documents')
        .select('id, title, filename, subject, sender, receiver, uploaded_at, type, category, document_date')
        .eq('org_id', orgId)
        .in('id', docIds);
        
      if (!docError && documents && documents.length > 0) {
        // Create a map for quick lookup
        const docMap = new Map(documents.map(doc => [doc.id, doc]));
        
        // Get content chunks for the top documents
        const topDocIds = searchResults.slice(0, 12).map(r => r.doc_id);
        const { data: chunks, error: chunkError } = await db
          .from('doc_chunks')
          .select('doc_id, content, chunk_index, page')
          .in('doc_id', topDocIds)
          .order('chunk_index');
          
        if (!chunkError && chunks && chunks.length > 0) {
          // Combine document metadata with content chunks
          const chunkMap = new Map();
          chunks.forEach(chunk => {
            if (!chunkMap.has(chunk.doc_id)) {
              chunkMap.set(chunk.doc_id, []);
            }
            chunkMap.get(chunk.doc_id).push(chunk);
          });
          
          // Create relevant chunks with scores
          relevantChunks = searchResults
            .filter(result => chunkMap.has(result.doc_id))
            .map(result => {
              const doc = docMap.get(result.doc_id);
              const docChunks = chunkMap.get(result.doc_id) || [];
              
              if (!doc || docChunks.length === 0) return null;
              
              return {
                doc_id: result.doc_id,
                content: docChunks.map(c => c.content).join('\n\n'),
                similarity: result.score,
                title: doc.title || doc.filename || 'Untitled',
                filename: doc.filename,
                doc_type: doc.type || null,
                uploaded_at: doc.uploaded_at,
                sources: result.sources
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.similarity - a.similarity);
        }
      }
    }
  } catch (hybridError) {
    console.error('Hybrid search failed:', hybridError);
  }
  
  // Fallback to original content search if hybrid search didn't work
  if (relevantChunks.length === 0) {
    // 1. Embed expanded query for semantic search
    const embedding = await embedQuery(expandedQuery).catch(() => null);
    
    if (embedding) {
      // Semantic search with expanded query
      send('stage', { agent: 'ContentAgent', step: 'semantic_search' });
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
  }
  
  if (relevantChunks.length === 0) {
    // Fallback to lexical search with expanded query
    send('stage', { agent: 'ContentAgent', step: 'lexical_search' });
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
  
  send('stage', { agent: 'ContentAgent', step: 'generating_answer' });
  
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

This is a summary based on the most relevant documents found using semantic search. Would you like me to elaborate on any specific aspect?`;
  
  // Create citations
  const topByDoc = new Map();
  for (const r of relevantChunks) {
    const id = r.doc_id;
    const score = Number(r.similarity || 0);
    const prev = topByDoc.get(id);
    if (!prev || score > prev.score) topByDoc.set(id, { score, page: (typeof r.page === 'number' ? r.page : null), snippet: String(r.content || '').slice(0, 500) });
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


// Enhanced casual conversation processing
async function processCasualQuery(question, conversation, routingResult, send) {
  send('stage', { agent: 'CasualAgent', step: 'responding' });
  
  // Simple pattern matching for common greetings and casual conversation
  const q = question.toLowerCase().trim();
  
  // Greetings
  if (/(^|\b)(hi|hello|hey|what's up|whats up|howdy)(\b|$)/.test(q)) {
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
