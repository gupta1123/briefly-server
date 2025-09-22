#!/usr/bin/env node

/**
 * Test routeQuestion without async wrapper
 * Run with: node test-route-question-direct.js
 */

// Copy the implementation without async
function routeQuestion(question, conversation = []) {
  // Extract context from conversation
  const recentMessages = conversation.slice(-3);
  const recentContent = recentMessages.map(m => `${m.role}: ${m.content}`).join('\n');
  
  console.log('Routing question:', question);
  console.log('Recent content:', recentContent);
  
  // Enhanced intent classification with better heuristics
  const intent = classifyIntent(question, recentContent);
  console.log('Intent classified as:', intent);
  
  const agentType = mapIntentToAgent(intent);
  console.log('Agent type mapped to:', agentType);
  
  const confidence = calculateConfidence(question, intent, recentContent);
  console.log('Confidence calculated as:', confidence);
  
  const agentName = getAgentName(agentType);
  console.log('Agent name:', agentName);
  
  const target = determineTarget(question, conversation);
  console.log('Target:', target);
  
  return {
    intent,
    agentType,
    agentName,
    confidence,
    target
  };
}

// Copy the helper functions
function classifyIntent(question, context) {
  const q = (question || '').toLowerCase().trim();
  const ctx = (context || '').toLowerCase();
  
  console.log('Classifying question:', q);
  
  // Metadata queries - asking about document properties
  if (/\b(what.*about|tell.*about|info.*about|details.*about|metadata.*for|properties.*of|characteristics.*of)\b/i.test(q) ||
      /\b(title|subject|sender|receiver|date|category|type|filename|document.*type|file.*type)\b.*\b(of|for|about)\b/i.test(q) ||
      /\b(list|show|find|search).*\b(documents?|files?)\b/i.test(q)) {
    console.log('Matched FindFiles pattern');
    return 'FindFiles';
  }
  
  // Metadata extraction - asking for specific metadata fields
  if (/\b(what.*title|what.*subject|who.*sender|who.*receiver|when.*date|what.*category|what.*type)\b/i.test(q) ||
      /\b(title|subject|sender|receiver|date|category|type|filename)\b/i.test(q)) {
    console.log('Matched Metadata pattern');
    return 'Metadata';
  }
  
  // Content QA - asking questions about document content
  if (/\b(what.*say|what.*state|what.*mention|what.*discuss|explain|describe|summarize|what.*about.*content)\b/i.test(q) ||
      /\b(content|information|details|facts|data)\b.*\b(in|about|regarding)\b/i.test(q)) {
    console.log('Matched ContentQA pattern');
    return 'ContentQA';
  }
  
  // Linked documents - asking about relationships
  if (/\b(linked|related|connected|associated|versions?|previous|next|later|earlier)\b/i.test(q) ||
      /\b(relations?|connections?|references?|citations?)\b/i.test(q)) {
    console.log('Matched Linked pattern');
    return 'Linked';
  }
  
  // Preview requests - wanting to see document content
  if (/\b(preview|show|view|see|look).*\b(document|file|content)\b/i.test(q) ||
      /\b(open|display|render)\b/i.test(q)) {
    console.log('Matched Preview pattern');
    return 'Preview';
  }
  
  // Timeline requests - chronological queries
  if (/\b(timeline|chronological|over.*time|history)\b/i.test(q) ||
      /\b(when.*happen|sequence.*events|order.*occurred)\b/i.test(q)) {
    console.log('Matched Timeline pattern');
    return 'Timeline';
  }
  
  // Extraction requests - structured data extraction
  if (/\b(extract|pull|get|gather|collect).*\b(fields?|data|information)\b/i.test(q) ||
      /\b(table|spreadsheet|csv|json|structured)\b/i.test(q)) {
    console.log('Matched Extract pattern');
    return 'Extract';
  }
  
  // Analysis requests - deeper document analysis
  if (/\b(analy(z|s)e|compare|contrast|evaluate|assess|review)\b/i.test(q) ||
      /\b(insights?|findings?|conclusions?|recommendations?)\b/i.test(q)) {
    console.log('Matched Analysis pattern');
    return 'Analysis';
  }
  
  // Financial document processing
  if (/\b(financial|invoice|bill|payment|amount|due|total|budget|expense|revenue)\b/i.test(q) ||
      /\b(financial|invoice|bill|payment|amount|due|total|budget|expense|revenue)\b/i.test(ctx)) {
    console.log('Matched Financial pattern');
    return 'Financial';
  }
  
  // Legal document processing
  if (/\b(legal|contract|agreement|law|liability|compliance|clause|section)\b/i.test(q) ||
      /\b(legal|contract|agreement|law|liability|compliance|clause|section)\b/i.test(ctx)) {
    console.log('Matched Legal pattern');
    return 'Legal';
  }
  
  // Resume/CV processing
  if (/\b(resume|cv|candidate|applicant|skills?|experience|education|qualification)\b/i.test(q) ||
      /\b(resume|cv|candidate|applicant|skills?|experience|education|qualification)\b/i.test(ctx)) {
    console.log('Matched Resume pattern');
    return 'Resume';
  }
  
  // Default to content QA for general questions
  console.log('Defaulting to ContentQA');
  return 'ContentQA';
}

function mapIntentToAgent(intent) {
  const intentToAgentMap = {
    'FindFiles': 'metadata',
    'Metadata': 'metadata',
    'ContentQA': 'content',
    'Linked': 'content',
    'Preview': 'content',
    'Timeline': 'content',
    'Extract': 'content',
    'Analysis': 'content',
    'Financial': 'financial',
    'Legal': 'legal',
    'Resume': 'resume'
  };
  
  return intentToAgentMap[intent] || 'content';
}

function getAgentName(agentType) {
  const agentNames = {
    'metadata': 'Metadata Agent',
    'content': 'Content Agent',
    'financial': 'Financial Agent',
    'legal': 'Legal Agent',
    'resume': 'Resume Agent'
  };
  
  return agentNames[agentType] || 'Content Agent';
}

function calculateConfidence(question, intent, context) {
  const q = (question || '').toLowerCase();
  const ctx = (context || '').toLowerCase();
  
  // Base confidence based on keyword match strength
  let confidence = 0.5; // Default baseline
  
  // Strong keyword matches increase confidence
  if (/\b(what.*about|tell.*about|info.*about|details.*about)\b/i.test(q)) {
    confidence += 0.2;
  }
  
  if (/\b(exactly|specifically|precisely)\b/i.test(q)) {
    confidence += 0.1;
  }
  
  if (/\b(title|subject|sender|receiver|date|category|type)\b/i.test(q)) {
    confidence += 0.15;
  }
  
  // Context relevance
  if (ctx.includes('document') || ctx.includes('file')) {
    confidence += 0.1;
  }
  
  // Cap confidence at 1.0
  return Math.min(confidence, 1.0);
}

function determineTarget(question, conversation) {
  const q = (question || '').toLowerCase();
  
  // Check for explicit ordinal references ("first document", "second file", etc.)
  const ordinalMatch = q.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|#\d+)\b/i);
  if (ordinalMatch) {
    const ordinal = ordinalMatch[1].toLowerCase();
    return { ordinal, prefer: 'list' };
  }
  
  // Check for focus references ("it", "this", "that", etc.)
  if (/\b(it|this|that|the.*one|previous|last)\b/i.test(q)) {
    return { prefer: 'focus' };
  }
  
  // Default to no specific target
  return {};
}

// Test the function
const testQuestion = 'What is the title of the contract from Microsoft?';
const result = routeQuestion(testQuestion, []);

console.log('\nFinal result:', JSON.stringify(result, null, 2));