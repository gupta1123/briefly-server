#!/usr/bin/env node

/**
 * Direct test of classifyIntent function
 * Run with: node direct-classify-test.js
 */

// Import the classifyIntent function by copying its implementation
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

// Test the function
const testQuestion = 'What is the title of the contract from Microsoft?';
const result = classifyIntent(testQuestion, '');

console.log('\nFinal result:', result);
