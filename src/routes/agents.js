// Enhanced Agent Routes - Proxy to the Agno service

import { z } from 'zod';
import { callAgnoChat, formatAgnoResponse } from '../lib/agno-service.js';
import { isAIDegraded, generateDegradedResponse } from '../lib/graceful-degradation.js';

export function registerAgentRoutes(app) {
  console.log('🤖 Registering enhanced agent routes...');

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
          sessionId: z.string().optional(),
          session_id: z.string().optional(),
        })
        .optional(),
      context: z
        .object({
          scope: z.enum(['org', 'doc', 'folder', 'admin']).optional(),
          docId: z.string().optional(),
          folderId: z.string().optional(),
        })
        .optional(),
      filters: z
        .object({
          sender: z.string().optional(),
          receiver: z.string().optional(),
          docType: z.string().optional(),
          category: z.string().optional(),
        })
        .optional(),
      strictCitations: z.boolean().optional(),
    });

    const {
      question,
      conversation = [],
      memory = {},
      context,
      filters,
      strictCitations,
    } = Schema.parse(req.body || {});

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    const send = (event, data) => reply.sse({ event, data: typeof data === 'string' ? data : JSON.stringify(data) });
    let streamClosed = false;
    const closeStream = () => {
      if (!streamClosed) {
        streamClosed = true;
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    };

    send('start', { ok: true });

    try {
      if (isAIDegraded()) {
        const degraded = await generateDegradedResponse({ question, documents: [], conversation, orgId, db });
        const fallbackConfidence = degraded.confidence || 0.4;
        send('mode', {
          mode: 'degraded',
          agentType: 'degraded',
          agentName: 'Fallback',
          intent: 'Degraded',
          confidence: fallbackConfidence,
          expandedQuery: { original: question, expanded: question, terms: [question] },
          entities: [],
        });
        send('delta', degraded.answer || '');
        send('end', {
          done: true,
          citations: degraded.citations || [],
          agentType: 'degraded',
          agentName: 'Fallback',
          intent: 'Degraded',
          confidence: fallbackConfidence,
          degraded: true,
          reason: degraded.reason || 'DEGRADED',
        });
        closeStream();
        return;
      }

      const { data } = await callAgnoChat({
        orgId,
        userId,
        question,
        conversation,
        memory,
        context,
        filters,
        strictCitations,
      });

      const formatted = formatAgnoResponse(data, question);
      const { raw, sessionId, ...payload } = formatted;

      const agentType = payload.agentType || 'agno';
      const agentName = payload.agentName || 'Agno Service';
      const confidence = typeof payload.confidence === 'number' ? payload.confidence : 0.5;
      const expandedQuery = payload.expandedQuery || { original: question, expanded: question, terms: [question] };
      const entities = Array.isArray(payload.entities) ? payload.entities : [];

      send('mode', {
        mode: agentType,
        agentType,
        agentName,
        intent: payload.intent,
        confidence,
        expandedQuery,
        entities,
      });

      send('delta', payload.answer || '');

      send('end', {
        done: true,
        citations: payload.citations || [],
        agentType,
        agentName,
        intent: payload.intent,
        confidence,
        agentInsights: payload.agentInsights || [],
        consensusResult: payload.consensusResult ?? null,
        executionTrace: payload.executionTrace || [],
        sessionId,
      });

      closeStream();
    } catch (error) {
      console.error('Agent processing error:', error);
      send('error', {
        message: error.message || 'An error occurred while processing your request',
        detail: error.details || null,
      });
      send('end', { done: true, citations: [] });
      closeStream();
    }
  });
}

async function ensureActiveMemberAgents(req) {
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

