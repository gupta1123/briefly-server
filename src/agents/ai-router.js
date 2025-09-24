#!/usr/bin/env node

/**
 * Enhanced Agent Router - AI-Powered Intent Classification with Genkit
 * This file ensures environment variables are properly loaded
 */

// Explicitly load environment variables if not already loaded
import 'dotenv/config';

import { z } from 'zod';
import { generateText, definePrompt, canMakeRequest, isProviderBackedOff, setProviderBackoffFromError } from '../lib/ai-service.js';
import { enhancedFallbackClassification, enhancedEntityExtraction, fallbackQueryExpansion } from '../lib/fallback-service.js';

/**
 * AI-powered intent classification using Genkit
 * @param {string} question - The user's question
 * @param {Array} conversation - Conversation history
 * @returns {Object} Classified intent with confidence and entities
 */
export async function classifyIntentWithAI(question, conversation = []) {
  try {
    // Explicitly check for API key in process.env
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    console.log('🔍 classifyIntentWithAI - API Key:', apiKey ? '✅ FOUND' : '❌ NOT FOUND');
    const routerModel = process.env.ROUTER_MODEL || process.env.GEMINI_ROUTER_MODEL || '';
    
    // Check rate limits
    if (apiKey && (isProviderBackedOff() || !canMakeRequest())) {
      console.log('⚠️  Rate limit exceeded for intent classification, using fallback');
      return fallbackClassification(question, conversation);
    }

    // If no API key, use fallback
    if (!apiKey) {
      return fallbackClassification(question, conversation);
    }

    // Prepare conversation context
    const recentMessages = conversation.slice(-3);
    const recentContent = recentMessages.map(m => `${m.role}: ${m.content}`).join('\n');

    // If a dedicated router model is specified, use a direct JSON prompt via generateText
    if (routerModel) {
      try { console.log('🧭 Router model override:', routerModel); } catch {}
      const routerPrompt = `You are an intelligent document assistant that classifies user intents.\n\nClassify the following question and provide structured output.\n\nContext:\n${recentContent || ''}\n\nQuestion:\n"${question}"\n\nAvailable Intent Types:\n- FindFiles: Searching for documents by properties (title, sender, date, etc.)\n- Metadata: Asking about document properties (title, subject, sender, etc.)\n- ContentQA: Questions about document content\n- Linked: Asking about related/linked documents\n- Preview: Wanting to see document content\n- Timeline: Chronological queries\n- Extract: Structured data extraction\n- Analysis: Deep document analysis\n- Summarize: Document summarization\n- Compare: Document comparison\n- Sentiment: Sentiment analysis\n- Casual: Casual conversation, greetings, small talk, general questions not related to documents\n- Custom: Other custom queries\n\nRespond ONLY with valid JSON in this exact format:\n{\n  "intent": "<intent>",\n  "agentType": "<agent_type>",\n  "confidence": <confidence_score_between_0_and_1>,\n  "needsClarification": <boolean>,\n  "clarificationQuestion": "<question_if_needs_clarification>"\n}`;
      const gen = await generateText({ prompt: routerPrompt, model: routerModel, temperature: 0.2 });
      let parsed;
      try { parsed = JSON.parse(gen.text || '{}'); } catch { parsed = null; }
      if (!parsed || typeof parsed.intent !== 'string' || typeof parsed.agentType !== 'string') {
        throw new Error('Router model did not return valid JSON');
      }
      return {
        intent: parsed.intent,
        agentType: parsed.agentType,
        agentName: getAgentName(parsed.agentType),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
        needsClarification: !!parsed.needsClarification,
        clarificationQuestion: parsed.clarificationQuestion
      };
    }

    // Otherwise use the structured Genkit prompt
    const { output } = await intentPrompt({ question, context: recentContent || '' });
    return {
      intent: output.intent,
      agentType: output.agentType,
      agentName: getAgentName(output.agentType),
      confidence: output.confidence,
      needsClarification: output.needsClarification || false,
      clarificationQuestion: output.clarificationQuestion
    };

  } catch (error) {
    console.error('AI intent classification failed:', error);
    try { setProviderBackoffFromError(error); } catch {}
    
    // Fallback to enhanced classification
    return enhancedFallbackClassification(question, conversation);
  }
}

// Hoisted prompts to avoid duplicate registrations across calls
const intentPrompt = definePrompt({
  name: 'intentClassifier',
  input: { schema: z.object({ question: z.string(), context: z.string() }) },
  output: { 
    schema: z.object({ 
      intent: z.enum([
        'FindFiles', 'Metadata', 'ContentQA', 'Linked', 'Preview', 
        'Timeline', 'Extract', 'Analysis', 'Summarize', 'Compare', 'Sentiment', 'Custom'
      ]),
      agentType: z.enum(['metadata', 'content', 'casual']),
      confidence: z.number().min(0).max(1),
      needsClarification: z.boolean().optional(),
      clarificationQuestion: z.string().optional()
    })
  },
  prompt: `You are an intelligent document assistant that classifies user intents. 

Classify the following question and provide structured output.

Context:
{{context}}

Question:
"{{question}}"

Available Intent Types:
- FindFiles: Searching for documents by properties (title, sender, date, etc.)
- Metadata: Asking about document properties (title, subject, sender, etc.)
- ContentQA: Questions about document content
- Linked: Asking about related/linked documents
- Preview: Wanting to see document content
- Timeline: Chronological queries
- Extract: Structured data extraction
- Analysis: Deep document analysis
- Summarize: Document summarization
- Compare: Document comparison
- Sentiment: Sentiment analysis
- Casual: Casual conversation, greetings, small talk, general questions not related to documents
- Custom: Other custom queries

Respond ONLY with valid JSON in this exact format:
{
  "intent": "<intent>",
  "agentType": "<agent_type>",
  "confidence": <confidence_score_between_0_and_1>,
  "needsClarification": <boolean>,
  "clarificationQuestion": "<question_if_needs_clarification>"
}

Example response:
{
  "intent": "Metadata",
  "agentType": "metadata",
  "confidence": 0.95,
  "needsClarification": false
}`
});

/**
 * AI-powered query expansion with Genkit
 * @param {string} question - Original question
 * @returns {Object} Expanded query with synonyms and related terms
 */
export async function expandQueryWithAI(question) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    console.log('🔍 expandQueryWithAI - API Key:', apiKey ? '✅ FOUND' : '❌ NOT FOUND');
    
    // Check rate limits
    if (apiKey && (isProviderBackedOff() || !canMakeRequest())) {
      console.log('⚠️  Rate limit exceeded for query expansion, using fallback');
      const terms = question.split(/\s+/).filter(term => term.length > 2);
      return {
        original: question,
        expanded: question,
        terms: terms,
        relatedConcepts: []
      };
    }

    // If no API key, use fallback
    if (!apiKey) {
      const terms = question.split(/\s+/).filter(term => term.length > 2);
      return {
        original: question,
        expanded: question,
        terms: terms,
        relatedConcepts: []
      };
    }

    const { output } = await expandPrompt({ question });

    return {
      original: output.original || question,
      expanded: output.expanded || question,
      terms: output.terms || [question],
      relatedConcepts: output.relatedConcepts || []
    };

  } catch (error) {
    console.error('AI query expansion failed:', error);
    try { setProviderBackoffFromError(error); } catch {}
    
    // Fallback to enhanced query expansion
    return fallbackQueryExpansion(question);
  }
}

const expandPrompt = definePrompt({
  name: 'queryExpander',
  input: { schema: z.object({ question: z.string() }) },
  output: { 
    schema: z.object({
      original: z.string(),
      expanded: z.string(),
      terms: z.array(z.string()),
      relatedConcepts: z.array(z.string())
    })
  },
  prompt: `Expand the following query by identifying synonyms, related terms, and broader concepts 
that would help improve document retrieval.

Original query: "{{question}}"

Respond ONLY with valid JSON in this exact format:
{
  "original": "<original_query>",
  "expanded": "<expanded_query_with_synonyms>",
  "terms": ["<term1>", "<term2>", "..."],
  "relatedConcepts": ["<concept1>", "<concept2>", "..."]
}

Example response:
{
  "original": "contract agreement",
  "expanded": "contract agreement document legal binding terms conditions",
  "terms": ["contract", "agreement", "document", "legal", "binding"],
  "relatedConcepts": ["legal document", "binding agreement", "terms and conditions"]
}`
});

/**
 * AI-powered entity extraction with Genkit
 * @param {string} question - User question
 * @returns {Array} Extracted entities
 */
export async function extractEntitiesWithAI(question) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    console.log('🔍 extractEntitiesWithAI - API Key:', apiKey ? '✅ FOUND' : '❌ NOT FOUND');
    
    // Check rate limits
    if (apiKey && (isProviderBackedOff() || !canMakeRequest())) {
      console.log('⚠️  Rate limit exceeded for entity extraction, using fallback');
      return fallbackEntityExtraction(question);
    }

    // If no API key, use fallback
    if (!apiKey) {
      return fallbackEntityExtraction(question);
    }

    const { output } = await entityPrompt({ question });

    return Array.isArray(output.entities) ? output.entities : [];

  } catch (error) {
    console.error('AI entity extraction failed:', error);
    try { setProviderBackoffFromError(error); } catch {}
    
    // Fallback to enhanced entity extraction
    return enhancedEntityExtraction(question);
  }
}

const entityPrompt = definePrompt({
  name: 'entityExtractor',
  input: { schema: z.object({ question: z.string() }) },
  output: { 
    schema: z.object({
      entities: z.array(z.object({
        type: z.string(),
        value: z.string(),
        confidence: z.number().min(0).max(1)
      }))
    })
  },
  prompt: `Extract named entities from the following text. Focus on document-related entities.

Text: "{{question}}"

Identify entities such as:
- Document titles (quoted text)
- Dates and time periods
- Organizations and companies
- People names
- Document types (contract, invoice, report, etc.)
- Categories and topics

Respond ONLY with valid JSON in this exact format:
{
  "entities": [
    {
      "type": "<entity_type>",
      "value": "<entity_value>",
      "confidence": <confidence_score_between_0_and_1>
    }
  ]
}

Example response:
{
  "entities": [
    {
      "type": "organization",
      "value": "Microsoft Corporation",
      "confidence": 0.9
    },
    {
      "type": "date",
      "value": "January 15, 2023",
      "confidence": 0.85
    }
  ]
}`
});

/**
 * Fallback classification when AI fails
 * @param {string} question - The user's question
 * @param {Array} conversation - Conversation history
 * @returns {Object} Basic intent classification
 */
export function fallbackClassification(question, conversation) {
  // Use the enhanced fallback service
  return enhancedFallbackClassification(question, conversation);
}

/**
 * Get human-readable agent name
 * @param {string} agentType - Agent type
 * @returns {string} Agent name
 */
function getAgentName(agentType) {
  const agentNames = {
    'metadata': 'Metadata Agent',
    'content': 'Content Agent',
    'casual': 'Casual Agent'
  };
  
  return agentNames[agentType] || 'Content Agent';
}

/**
 * Fallback entity extraction with regex
 * @param {string} question - User question
 * @returns {Array} Extracted entities
 */
function fallbackEntityExtraction(question) {
  // Use the enhanced fallback service
  return enhancedEntityExtraction(question);
}

/**
 * Main routing function that uses AI for intent classification
 * @param {string} question - User question
 * @param {Array} conversation - Conversation history
 * @returns {Object} Routing decision
 */
export async function routeQuestion(question, conversation = []) {
  try {
    console.log('🔍 routeQuestion called with:', question);
    
    // Use AI for intent classification
    const intentResult = await classifyIntentWithAI(question, conversation);
    console.log('🧠 Intent classification result:', intentResult);
    
    // If clarification is needed, return that
    if (intentResult.needsClarification) {
      return {
        ...intentResult,
        target: {},
        expandedQuery: { original: question, expanded: question, terms: [question], relatedConcepts: [] },
        entities: []
      };
    }
    
    // Enhance with query expansion and entity extraction
    console.log('🔍 Expanding query...');
    const [expandedQuery, entities] = await Promise.all([
      expandQueryWithAI(question),
      extractEntitiesWithAI(question)
    ]);
    
    console.log('🧠 Query expansion result:', expandedQuery);
    console.log('🧠 Entity extraction result:', entities);
    
    return {
      ...intentResult,
      expandedQuery,
      entities: entities,
      target: determineTarget(question, conversation)
    };
    
  } catch (error) {
    console.error('Routing failed:', error);
    
    // Fallback to basic routing
    return {
      intent: 'ContentQA',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false,
      target: {},
      expandedQuery: { original: question, expanded: question, terms: [question], relatedConcepts: [] },
      entities: []
    };
  }
}

/**
 * Determine target document(s) for the query
 * @param {string} question - User question
 * @param {Array} conversation - Conversation history
 * @returns {Object} Target information
 */
function determineTarget(question, conversation) {
  const q = (question || '').toLowerCase();
  
  // Check for explicit ordinal references
  const ordinalMatch = q.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|#\d+)\b/i);
  if (ordinalMatch) {
    const ordinal = ordinalMatch[1].toLowerCase();
    return { ordinal, prefer: 'list' };
  }
  
  // Check for focus references
  if (/\b(it|this|that|the.*one|previous|last)\b/i.test(q)) {
    return { prefer: 'focus' };
  }
  
  // Default to no specific target
  return {};
}
