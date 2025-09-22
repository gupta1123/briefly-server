#!/usr/bin/env node

/**
 * Test fallback classification
 * Run with: node test-fallback-classification.js
 */

function fallbackClassification(question, conversation) {
  const q = (question || '').toLowerCase().trim();
  
  console.log('Testing fallback classification for:', q);
  
  // Simple keyword-based classification as fallback
  if (/\b(what.*about|tell.*about|info.*about|details.*about|metadata.*for|properties.*of|characteristics.*of)\b/i.test(q) ||
      /\b(title|subject|sender|receiver|date|category|type|filename|document.*type|file.*type)\b.*\b(of|for|about)\b/i.test(q) ||
      /\b(list|show|find|search).*\b(documents?|files?)\b/i.test(q)) {
    console.log('Matched FindFiles pattern');
    return {
      intent: 'FindFiles',
      agentType: 'metadata',
      agentName: 'Metadata Agent',
      confidence: 0.7,
      needsClarification: false
    };
  }
  
  if (/\b(what.*title|what.*subject|who.*sender|who.*receiver|when.*date|what.*category|what.*type)\b/i.test(q) ||
      /\b(title|subject|sender|receiver|date|category|type|filename)\b/i.test(q)) {
    console.log('Matched Metadata pattern');
    return {
      intent: 'Metadata',
      agentType: 'metadata',
      agentName: 'Metadata Agent',
      confidence: 0.7,
      needsClarification: false
    };
  }
  
  if (/\b(what.*say|what.*state|what.*mention|what.*discuss|explain|describe|summarize|what.*about.*content)\b/i.test(q) ||
      /\b(content|information|details|facts|data)\b.*\b(in|about|regarding)\b/i.test(q)) {
    console.log('Matched ContentQA pattern');
    return {
      intent: 'ContentQA',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  if (/\b(linked|related|connected|associated|versions?|previous|next|later|earlier)\b/i.test(q) ||
      /\b(relations?|connections?|references?|citations?)\b/i.test(q)) {
    console.log('Matched Linked pattern');
    return {
      intent: 'Linked',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  if (/\b(preview|show|view|see|look).*\b(document|file|content)\b/i.test(q) ||
      /\b(open|display|render)\b/i.test(q)) {
    console.log('Matched Preview pattern');
    return {
      intent: 'Preview',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  if (/\b(timeline|chronological|over.*time|history)\b/i.test(q) ||
      /\b(when.*happen|sequence.*events|order.*occurred)\b/i.test(q)) {
    console.log('Matched Timeline pattern');
    return {
      intent: 'Timeline',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  if (/\b(extract|pull|get|gather|collect).*\b(fields?|data|information)\b/i.test(q) ||
      /\b(table|spreadsheet|csv|json|structured)\b/i.test(q)) {
    console.log('Matched Extract pattern');
    return {
      intent: 'Extract',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  if (/\b(analy(z|s)e|compare|contrast|evaluate|assess|review)\b/i.test(q) ||
      /\b(insights?|findings?|conclusions?|recommendations?)\b/i.test(q)) {
    console.log('Matched Analysis pattern');
    return {
      intent: 'Analysis',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  if (/\b(financial|invoice|bill|payment|amount|due|total|budget|expense|revenue)\b/i.test(q) ||
      /\b(financial|invoice|bill|payment|amount|due|total|budget|expense|revenue)\b/i.test(q)) {
    console.log('Matched Financial pattern');
    return {
      intent: 'Financial',
      agentType: 'financial',
      agentName: 'Financial Agent',
      confidence: 0.6,
      needsClarification: false
    };
  }
  
  if (/\b(legal|contract|agreement|law|liability|compliance|clause|section)\b/i.test(q) ||
      /\b(legal|contract|agreement|law|liability|compliance|clause|section)\b/i.test(q)) {
    console.log('Matched Legal pattern');
    return {
      intent: 'Legal',
      agentType: 'legal',
      agentName: 'Legal Agent',
      confidence: 0.6,
      needsClarification: false
    };
  }
  
  if (/\b(resume|cv|candidate|applicant|skills?|experience|education|qualification)\b/i.test(q) ||
      /\b(resume|cv|candidate|applicant|skills?|experience|education|qualification)\b/i.test(q)) {
    console.log('Matched Resume pattern');
    return {
      intent: 'Resume',
      agentType: 'resume',
      agentName: 'Resume Agent',
      confidence: 0.6,
      needsClarification: false
    };
  }
  
  // Default to content QA for general questions
  console.log('Defaulting to ContentQA');
  return {
    intent: 'ContentQA',
    agentType: 'content',
    agentName: 'Content Agent',
    confidence: 0.5,
    needsClarification: false
  };
}

// Test the function
const testQuestion = 'hey bro';
const result = fallbackClassification(testQuestion, []);

console.log('\nFinal result:', JSON.stringify(result, null, 2));