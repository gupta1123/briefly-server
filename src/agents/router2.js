import { listTools } from '../tools/registry.js';
import { routeQuestion as legacyRoute } from './ai-router.js';
import { isProviderBackedOff } from '../lib/ai-service.js';

function tokenize(q){ return String(q||'').trim().split(/\s+/).filter(Boolean); }

function isListQuery(q){
  const s = String(q||'').toLowerCase();
  return (/(^|\b)(find|show|list|display)\b/.test(s) || /\ball\b/.test(s)) && /(doc|docs|document|documents|file|files|records|papers|items)/.test(s);
}

function isDocCountQuery(q){
  const s = String(q||'');
  return /\b(how many|count|total number)\b/i.test(s) && /\b(documents?|docs?|files?|records?|items?)\b/i.test(s);
}

function isEntityCountQuery(q){
  const s = String(q||'');
  return /\b(how many|number of|count of)\b/i.test(s) && !/\b(documents?|docs?|files?|records?|items?)\b/i.test(s);
}

function isCompareQuery(q){
  const s = String(q||'').toLowerCase();
  return /(compare|difference|diff|vs\.?)/.test(s);
}

function isLinkedQuery(q){
  const s = String(q||'').toLowerCase();
  return /(linked|links|versions?|related|relationships?)/.test(s);
}

function isFIRFieldQuery(q){
  const s = String(q||'').toLowerCase();
  return /\bfir\b/.test(s) && (/(number|no\.?|date)/.test(s));
}

function isComplainantQuery(q){
  const s = String(q||'').toLowerCase();
  return /(complainant|informant)/.test(s);
}

function detectScope(context){
  const scope = (context?.scope === 'doc' || context?.scope === 'folder') ? context.scope : 'org';
  return scope;
}

export async function routeWithTools({ db, orgId, question, conversation = [], memory = {}, context = {} }){
  const scope = detectScope(context);
  const words = tokenize(question);
  const tools = listTools(); // presently unused in logic, but could be embedded in LLM prompt later

  // Very short → ask to clarify
  if (words.length < 2) {
    return { intent: 'Clarify', scope, action: 'ask', primaryTool: null, supportingTools: [], target: {}, required_entities: [], confidence: 0.3, askClarify: true };
  }

  // Deterministic routes
  if (isListQuery(question)) {
    return { intent: 'ListDocs', scope, action: 'search', primaryTool: 'metadata_search', supportingTools: [], target: {}, required_entities: [], confidence: 0.9, askClarify: false };
  }
  if (scope === 'folder' && isDocCountQuery(question)) {
    return { intent: 'DocCount', scope, action: 'count', primaryTool: 'folder_count', supportingTools: [], target: {}, required_entities: [], confidence: 0.95, askClarify: false };
  }
  if (isEntityCountQuery(question)) {
    return { intent: 'FieldExtract', scope, action: 'extract', primaryTool: 'extract_numeric', supportingTools: ['vector_search'], target: {}, required_entities: ['count'], confidence: 0.85, askClarify: false };
  }
  if (isCompareQuery(question)) {
    return { intent: 'Compare', scope, action: 'compare', primaryTool: 'rerank', supportingTools: ['vector_search'], target: {}, required_entities: [], confidence: 0.8, askClarify: false };
  }
  if (isLinkedQuery(question)) {
    return { intent: 'Linked', scope, action: 'linked', primaryTool: 'linked_docs', supportingTools: [], target: {}, required_entities: [], confidence: 0.8, askClarify: false };
  }

  // Specific field extraction patterns (FIR, complainant)
  // In folder scope, prefer broader content QA over narrow field extraction to avoid over-routing
  if (isFIRFieldQuery(question) || isComplainantQuery(question)) {
    if (scope === 'folder') {
      return { intent: 'ContentQA', scope, action: 'qa', primaryTool: 'vector_search', supportingTools: ['rerank'], target: {}, required_entities: [], confidence: 0.8, askClarify: false };
    }
    return { intent: 'FieldExtract', scope, action: 'extract', primaryTool: 'extract_field', supportingTools: ['vector_search'], target: {}, required_entities: ['fields'], confidence: 0.85, askClarify: false };
  }

  // Gated LLM router fallback
  if (!isProviderBackedOff()) {
    try {
      const r = await legacyRoute(question, conversation);
      // Map legacy agentType to intents/tools
      let intent = 'ContentQA';
      let primaryTool = 'vector_search';
      if (r.agentType === 'metadata') { intent = 'ListDocs'; primaryTool = 'metadata_search'; }
      return { intent, scope, action: intent === 'ListDocs' ? 'search' : 'qa', primaryTool, supportingTools: intent==='ListDocs'?[]:['rerank'], target: {}, required_entities: [], confidence: r.confidence || 0.6, askClarify: false };
    } catch {}
  }

  // Folder-aware default: prefer FolderQA aggregator over single-doc QA
  if (scope === 'folder') {
    return { intent: 'FolderQA', scope, action: 'qa_across_docs', primaryTool: 'folder_multi_doc_qa', supportingTools: ['vector_search'], target: {}, required_entities: [], confidence: 0.65, askClarify: false };
  }
  // Default fallback
  return { intent: 'ContentQA', scope, action: 'qa', primaryTool: 'vector_search', supportingTools: ['rerank'], target: {}, required_entities: [], confidence: 0.6, askClarify: false };
}
