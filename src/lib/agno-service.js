import { loadEnv } from '../env.js';

const env = loadEnv();
const BASE_URL = env.AGNO_SERVICE_URL ? env.AGNO_SERVICE_URL.replace(/\/$/, '') : null;
const AUTH_TOKEN = env.AGNO_SERVICE_TOKEN;

function buildChatUrl(orgId, userId, context) {
  if (!BASE_URL) {
    throw new Error('AGNO_SERVICE_URL is not configured');
  }

  const scope = context?.scope || 'org';
  let path = `/api/v1/chat/organization/${orgId}`;

  if (scope === 'doc' && context?.docId) {
    path = `/api/v1/chat/document/${context.docId}`;
  } else if (scope === 'folder' && context?.folderId) {
    path = `/api/v1/chat/folder/${context.folderId}`;
  } else if (scope === 'admin') {
    path = `/api/v1/chat/admin/${orgId}`;
  }

  const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
  const url = new URL(path.replace(/^\//, ''), base);
  url.searchParams.set('org_id', orgId);
  if (userId) url.searchParams.set('user_id', userId);
  return url;
}

export async function callAgnoChat({
  orgId,
  userId,
  question,
  conversation,
  memory,
  context,
  filters,
  strictCitations,
}) {
  if (!orgId) throw new Error('orgId is required to call Agno service');
  if (!question) throw new Error('question is required to call Agno service');

  const url = buildChatUrl(orgId, userId, context);

  const sessionId = memory?.sessionId || memory?.session_id;
  const payload = {
    question,
    conversation,
    memory,
    context,
    filters,
    strictCitations,
    user_id: userId,
    session_id: sessionId,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  let response;
  let text;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    text = await response.text();
  } catch (error) {
    throw new Error(`Failed to reach Agno service: ${error.message}`);
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      if (response.ok) {
        throw new Error('Agno service returned non-JSON response');
      }
    }
  }

  if (!response.ok) {
    const errMsg = data?.error || data?.message || `Agno service error (${response.status})`;
    const error = new Error(errMsg);
    error.status = response.status;
    error.details = data || text;
    throw error;
  }

  return {
    data: data || {},
    status: response.status,
    endpoint: url.toString(),
  };
}

export function formatAgnoResponse(data, question) {
  const answer = typeof data?.answer === 'string' && data.answer.trim().length > 0
    ? data.answer
    : (typeof data?.content === 'string' ? data.content : '');
  const citations = Array.isArray(data?.citations) ? data.citations : [];
  const agentLabel = typeof data?.agent === 'string' && data.agent.trim().length > 0
    ? data.agent
    : (typeof data?.agentName === 'string' ? data.agentName : null);
  const confidence = typeof data?.confidence === 'number'
    ? data.confidence
    : (typeof data?.confidenceScore === 'number' ? data.confidenceScore : 0.5);

  const expandedQuery = (data?.expandedQuery && typeof data.expandedQuery === 'object')
    ? data.expandedQuery
    : { original: question, expanded: question, terms: [question] };

  const formatted = {
    answer,
    citations,
    agentType: agentLabel || 'agno',
    agentName: agentLabel || 'Agno Service',
    confidence,
    intent: data?.intent || 'ContentQA',
    expandedQuery,
    entities: Array.isArray(data?.entities) ? data.entities : [],
    agentInsights: Array.isArray(data?.agentInsights) ? data.agentInsights : [],
    consensusResult: data?.consensusResult ?? null,
    executionTrace: Array.isArray(data?.executionTrace) ? data.executionTrace : [],
    sessionId: data?.session_id || data?.sessionId,
    considered: data?.considered || { docIds: [] },
    error: Boolean(data?.error),
    raw: data,
  };

  if (agentLabel) {
    formatted.agent = {
      type: agentLabel,
      name: agentLabel,
      confidence,
    };
  }

  return formatted;
}

