// Streaming Test Agent Routes - Server-Sent Events implementation
// This file implements streaming chat functionality with real-time responses

import { z } from 'zod';
import { callAgnoChatStream, formatAgnoResponse } from '../lib/agno-service-streaming.js';
import { isAIDegraded, generateDegradedResponse } from '../lib/graceful-degradation.js';

/**
 * Register streaming test agent routes
 * @param {Object} app - Fastify app instance
 */
export function registerStreamingTestAgentRoutes(app) {
  console.log('🌊 Registering streaming test agent routes...');

  // Document-specific streaming chat endpoint
  app.post('/orgs/:orgId/chat/document/:documentId/stream', {
    preHandler: [app.verifyAuth, app.requireIpAccess]
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const documentId = req.params.documentId;

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
          sessionId: z.string().optional(),
        })
        .optional(),
      filters: z.object({
        sender: z.string().optional(),
        receiver: z.string().optional(),
        docType: z.string().optional(),
        category: z.string().optional(),
      }).optional(),
      strictCitations: z.boolean().optional(),
    });

    const { question, conversation = [], memory: userMemory = {}, filters = {}, strictCitations } = Schema.parse(req.body || {});

    try {
      const normalizedMemory = userMemory && typeof userMemory === 'object' ? userMemory : {};
      
      // Set up SSE
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('Access-Control-Allow-Origin', '*');
      
      const sendSSE = (data) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Send initial event
      sendSSE({ type: 'start', ok: true });

      // Call Agno service with document context
      const agnoContext = {
        scope: 'doc',
        docId: documentId,
        includeSubfolders: false,
        includeLinked: false,
        includeVersions: false,
      };

      const agnoParams = {
        orgId,
        userId,
        question,
        conversation,
        memory: normalizedMemory,
        context: agnoContext,
        filters,
        strictCitations,
      };

      // Stream response from Agno service
      for await (const chunk of callAgnoChatStream(agnoParams)) {
        sendSSE(chunk);
      }

      // Send completion event
      sendSSE({ type: 'complete', ok: true });
      
    } catch (error) {
      console.error('Document streaming chat error:', error);
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  // Folder-specific streaming chat endpoint
  app.post('/orgs/:orgId/chat/folder/:folderId/stream', {
    preHandler: [app.verifyAuth, app.requireIpAccess]
  }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const folderId = req.params.folderId;

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
          sessionId: z.string().optional(),
        })
        .optional(),
      filters: z.object({
        sender: z.string().optional(),
        receiver: z.string().optional(),
        docType: z.string().optional(),
        category: z.string().optional(),
      }).optional(),
      strictCitations: z.boolean().optional(),
    });

    const { question, conversation = [], memory: userMemory = {}, filters = {}, strictCitations } = Schema.parse(req.body || {});

    try {
      const normalizedMemory = userMemory && typeof userMemory === 'object' ? userMemory : {};
      
      // Set up SSE
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('Access-Control-Allow-Origin', '*');
      
      const sendSSE = (data) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Send initial event
      sendSSE({ type: 'start', ok: true });

      // Call Agno service with folder context
      const agnoContext = {
        scope: 'folder',
        folderId: folderId,
        includeSubfolders: true,
        includeLinked: false,
        includeVersions: false,
      };

      const agnoParams = {
        orgId,
        userId,
        question,
        conversation,
        memory: normalizedMemory,
        context: agnoContext,
        filters,
        strictCitations,
      };

      // Stream response from Agno service
      for await (const chunk of callAgnoChatStream(agnoParams)) {
        sendSSE(chunk);
      }

      // Send completion event
      sendSSE({ type: 'complete', ok: true });
      
    } catch (error) {
      console.error('Folder streaming chat error:', error);
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  // Organization-wide streaming chat endpoint with Server-Sent Events
  app.post('/orgs/:orgId/chat/stream', {
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
      webSearchEnabled: z.boolean().optional().default(false),
    });

    const { question, conversation = [], memory: userMemory = {}, context = { scope: 'org' }, filters = {}, strictCitations, webSearchEnabled } = Schema.parse(req.body || {});

    try {
      const normalizedMemory = userMemory && typeof userMemory === 'object' ? userMemory : {};

      // Handle ordinal queries (e.g., "show me the first document")
      const parseOrdinal = (txt) => {
        const m = String(txt || '').toLowerCase().match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|#(\d+))\b/);
        if (!m) return null;
        const map = new Map([
          ['first', 1],
          ['second', 2],
          ['third', 3],
          ['fourth', 4],
          ['fifth', 5],
          ['1st', 1],
          ['2nd', 2],
          ['3rd', 3],
          ['4th', 4],
          ['5th', 5],
        ]);
        if (m[2]) return Number(m[2]);
        const v = map.get(m[1]);
        return v || null;
      };

      const lastListDocIds = Array.isArray(normalizedMemory.lastListDocIds) ? normalizedMemory.lastListDocIds : [];
      const ord = parseOrdinal(question);
      if (ord && lastListDocIds.length > 0) {
        const idx = Math.max(0, ord - 1);
        const targetId = lastListDocIds[idx];
        if (targetId) {
          const { data: doc, error: docError } = await db
            .from('documents')
            .select('id, title, filename, subject, sender, receiver, document_date, category, type')
            .eq('org_id', orgId)
            .eq('id', targetId)
            .maybeSingle();
          if (!docError && doc) {
            const name = doc.title || doc.filename || 'Untitled';
            const parts = [name];
            if (doc.document_date) parts.push(String(doc.document_date));
            if (doc.type) parts.push(String(doc.type));
            if (doc.sender) parts.push(String(doc.sender));
            const suffix = ord === 1 ? 'st' : ord === 2 ? 'nd' : ord === 3 ? 'rd' : 'th';
            const answer = `### Details for the ${ord}${suffix} item\n\n- ${parts.join(' — ')}`;
            
            // Send as streaming response
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            });
            
            // Send initial tool call event
            reply.raw.write(`data: ${JSON.stringify({
              type: 'tool_call',
              message: '🔍 Using ordinal memory lookup...'
            })}\n\n`);
            
            // Send content chunks
            const content = answer;
            const chunkSize = 50;
            for (let i = 0; i < content.length; i += chunkSize) {
              const chunk = content.slice(i, i + chunkSize);
              reply.raw.write(`data: ${JSON.stringify({
                type: 'content',
                chunk: chunk,
                full_content: content.slice(0, i + chunkSize),
                chunk_count: Math.floor(i / chunkSize) + 1,
                is_complete: false
              })}\n\n`);
              await new Promise(resolve => setTimeout(resolve, 50)); // Small delay for streaming effect
            }
            
            // Send completion event
            reply.raw.write(`data: ${JSON.stringify({
              type: 'complete',
              full_content: answer,
              chunk_count: Math.ceil(content.length / chunkSize),
              total_time: content.length * 50 / 1000,
              chars_per_second: 1000 / 50,
              citations: [{ docId: doc.id, docName: name, snippet: `${name} — ${doc.document_date || ''}` }],
              agent: { type: 'metadata', name: 'OrdinalSelector', confidence: 0.95 },
              is_complete: true
            })}\n\n`);
            
            reply.raw.end();
            return;
          }
        }
      }

      // Handle degraded mode
      if (isAIDegraded()) {
        const degraded = await generateDegradedResponse({ question, documents: [], conversation, orgId, db });
        
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        
        // Stream degraded response
        const content = degraded.answer;
        const chunkSize = 50;
        for (let i = 0; i < content.length; i += chunkSize) {
          const chunk = content.slice(i, i + chunkSize);
          reply.raw.write(`data: ${JSON.stringify({
            type: 'content',
            chunk: chunk,
            full_content: content.slice(0, i + chunkSize),
            chunk_count: Math.floor(i / chunkSize) + 1,
            is_complete: false
          })}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        reply.raw.write(`data: ${JSON.stringify({
          type: 'complete',
          full_content: content,
          chunk_count: Math.ceil(content.length / chunkSize),
          total_time: content.length * 50 / 1000,
          chars_per_second: 1000 / 50,
          citations: degraded.citations || [],
          agent: { type: 'degraded', name: 'Fallback', confidence: degraded.confidence || 0.4 },
          degraded: true,
          is_complete: true
        })}\n\n`);
        
        reply.raw.end();
        return;
      }

      // Call streaming Agno service
      const stream = await callAgnoChatStream({
        orgId,
        userId,
        question,
        conversation,
        memory: normalizedMemory,
        context,
        filters,
        strictCitations,
        webSearchEnabled,
      });

      // Set up Server-Sent Events headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Stream the response
      for await (const chunk of stream) {
        const formatted = formatAgnoResponse(chunk, question);
        reply.raw.write(`data: ${JSON.stringify(formatted)}\n\n`);
      }

      reply.raw.end();

    } catch (error) {
      console.error('Streaming agent processing error:', error);
      
      // Check if headers were already sent
      if (!reply.raw.headersSent) {
        // Send error as streaming response
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
      }
      
      const errorMessage = error.message && error.message.includes('rate limit')
        ? 'The AI service is currently busy due to rate limits. Please wait a moment and try again.'
        : error.message && error.message.includes('quota')
        ? 'The AI service has reached its quota limit. Please try again later.'
        : 'An error occurred while processing your request. Please try again.';
      
      reply.raw.write(`data: ${JSON.stringify({
        type: 'error',
        error: errorMessage,
        is_complete: true
      })}\n\n`);
      
      reply.raw.end();
    }
  });

  console.log('✅ Streaming test agent routes registered');
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

