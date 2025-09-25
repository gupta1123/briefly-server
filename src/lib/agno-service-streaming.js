import { loadEnv } from '../env.js';

const env = loadEnv();
const BASE_URL = env.AGNO_SERVICE_URL ? env.AGNO_SERVICE_URL.replace(/\/$/, '') : null;
const AUTH_TOKEN = env.AGNO_SERVICE_TOKEN;

function buildChatUrl(orgId, userId, context) {
  if (!BASE_URL) {
    throw new Error('AGNO_SERVICE_URL is not configured');
  }

  const scope = context?.scope || 'org';
  let path = `/api/v1/chat/organization/${orgId}/stream`;

  if (scope === 'doc' && context?.docId) {
    path = `/api/v1/chat/document/${context.docId}/stream`;
  } else if (scope === 'folder' && context?.folderId) {
    path = `/api/v1/chat/folder/${context.folderId}/stream`;
  } else if (scope === 'admin') {
    path = `/api/v1/chat/admin/${orgId}/stream`;
  }

  const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
  const url = new URL(path.replace(/^\//, ''), base);
  url.searchParams.set('org_id', orgId);
  if (userId) url.searchParams.set('user_id', userId);
  return url;
}

export async function* callAgnoChatStream({
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
    stream: true, // Enable streaming
  };

  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData = null;
      try {
        errorData = JSON.parse(errorText);
      } catch {}
      
      const errMsg = errorData?.error || errorData?.message || `Agno service error (${response.status})`;
      const error = new Error(errMsg);
      error.status = response.status;
      error.details = errorData || errorText;
      throw error;
    }

    // Check if response is streaming
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/event-stream')) {
      // Handle Server-Sent Events
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                console.log('SSE data parsed:', data.type, data);
                const formatted = formatAgnoResponse(data, question);
                if (formatted) {
                  yield formatted;
                }
              } catch (parseError) {
                console.warn('Failed to parse SSE data:', line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      // Handle regular JSON response (fallback)
      const text = await response.text();
      let data = null;
      
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (parseError) {
          throw new Error('Agno service returned non-JSON response');
        }
      }

      // Convert single response to streaming format
      yield {
        type: 'content',
        chunk: data?.answer || data?.content || '',
        full_content: data?.answer || data?.content || '',
        chunk_count: 1,
        is_complete: false
      };

      yield {
        type: 'complete',
        full_content: data?.answer || data?.content || '',
        chunk_count: 1,
        total_time: 1,
        chars_per_second: (data?.answer || data?.content || '').length,
        citations: data?.citations || [],
        agent: data?.agent || { type: 'agno', name: 'Agno Service', confidence: 0.8 },
        is_complete: true,
        raw: data
      };
    }

  } catch (error) {
    throw new Error(`Failed to reach Agno service: ${error.message}`);
  }
}

export function formatAgnoResponse(data, question) {
  // Handle different response types
  if (data.type === 'content') {
    return {
      type: 'content',
      chunk: data.chunk,
      full_content: data.full_content,
      chunk_count: data.chunk_count,
      is_complete: data.is_complete || false
    };
  }

  if (data.type === 'tool_call') {
    return {
      type: 'tool_call',
      message: data.message || 'Using tools...'
    };
  }

  if (data.type === 'complete') {
    const answer = data.full_content || '';
    const citations = Array.isArray(data.citations) ? data.citations : [];
    const agent = data.agent || { type: 'agno', name: 'Agno Service', confidence: 0.8 };

    return {
      type: 'complete',
      full_content: answer,
      chunk_count: data.chunk_count || 1,
      total_time: data.total_time || 1,
      chars_per_second: data.chars_per_second || answer.length,
      citations,
      agent,
      agentType: agent.type,
      agentName: agent.name,
      confidence: agent.confidence,
      intent: data.intent || 'ContentQA',
      expandedQuery: data.expandedQuery || { original: question, expanded: question, terms: [question] },
      entities: Array.isArray(data.entities) ? data.entities : [],
      agentInsights: Array.isArray(data.agentInsights) ? data.agentInsights : [],
      consensusResult: data.consensusResult ?? null,
      executionTrace: Array.isArray(data.executionTrace) ? data.executionTrace : [],
      sessionId: data.sessionId,
      considered: data.considered || { docIds: [] },
      error: Boolean(data.error),
      raw: data.raw,
      is_complete: true
    };
  }

  if (data.type === 'error') {
    return {
      type: 'error',
      error: data.error,
      is_complete: true
    };
  }

  if (data.type === 'task_step') {
    return {
      type: 'task_step',
      step: data.step,
      title: data.title,
      status: data.status,
      description: data.description
    };
  }

  if (data.type === 'tool_usage') {
    return {
      type: 'tool_usage',
      name: data.name,
      status: data.status,
      description: data.description
    };
  }

  // Fallback for unknown types - don't convert to content
  console.warn('Unknown data type:', data.type, data);
  return null; // Skip unknown types
}
