#!/usr/bin/env node

/**
 * Enhanced routing with better casual greeting handling
 * Run with: node enhanced-routing-with-greetings.js
 */

// Enhanced fallback classification that handles casual greetings
function enhancedFallbackClassification(question, conversation) {
  const q = (question || '').toLowerCase().trim();
  
  console.log('🔄 Using enhanced fallback classification for:', q);
  
  // Handle casual greetings and chit-chat
  if (/^\s*(hey|hi|hello|what'?s up|howdy|greetings?|salutations?|yo)\b/i.test(q) ||
      /^\s*(hey|hi|hello|what'?s up|howdy|greetings?|salutations?|yo).*\b(bro|man|dude|friend|pal|mate|buddy|chief|boss)\b/i.test(q) ||
      /^\s*(what'?s|whats|what is)\s+(up|going on|happening|the deal|the word)\s*\??\s*$/i.test(q)) {
    console.log('   Matched Casual Greeting pattern');
    return {
      intent: 'Greeting',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.9,
      needsClarification: false
    };
  }
  
  // Handle simple questions
  if (/^\s*(how are you|how'?s it going|how do you do|what'?s new)\s*\??\s*$/i.test(q) ||
      /^\s*(fine|good|okay|great|awesome|fantastic|wonderful|amazing|terrible|awful|horrible|bad)\s*\??\s*$/i.test(q)) {
    console.log('   Matched Simple Question pattern');
    return {
      intent: 'SmallTalk',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.8,
      needsClarification: false
    };
  }
  
  // Handle thanks and appreciation
  if (/^\s*(thanks|thank you|thx|appreciate it|gracias|merci|danke)\b/i.test(q) ||
      /^\s*(you'?re welcome|you'?re the best|awesome|great job|nice work|well done)\b/i.test(q)) {
    console.log('   Matched Appreciation pattern');
    return {
      intent: 'Appreciation',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.9,
      needsClarification: false
    };
  }
  
  // Handle yes/no responses
  if (/^\s*(yes|no|yeah|yep|nope|sure|definitely|absolutely|maybe|perhaps|possibly)\b/i.test(q)) {
    console.log('   Matched Yes/No pattern');
    return {
      intent: 'Confirmation',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.8,
      needsClarification: false
    };
  }
  
  // Handle metadata queries - asking about document properties
  if (/\b(what.*about|tell.*about|info.*about|details.*about|metadata.*for|properties.*of|characteristics.*of)\b/i.test(q) ||
      /\b(title|subject|sender|receiver|date|category|type|filename|document.*type|file.*type)\b.*\b(of|for|about)\b/i.test(q) ||
      /\b(list|show|find|search).*\b(documents?|files?)\b/i.test(q)) {
    console.log('   Matched FindFiles pattern');
    return {
      intent: 'FindFiles',
      agentType: 'metadata',
      agentName: 'Metadata Agent',
      confidence: 0.7,
      needsClarification: false
    };
  }
  
  // Handle metadata extraction - asking for specific metadata fields
  if (/\b(what.*title|what.*subject|who.*sender|who.*receiver|when.*date|what.*category|what.*type)\b/i.test(q) ||
      /\b(title|subject|sender|receiver|date|category|type|filename)\b/i.test(q)) {
    console.log('   Matched Metadata pattern');
    return {
      intent: 'Metadata',
      agentType: 'metadata',
      agentName: 'Metadata Agent',
      confidence: 0.7,
      needsClarification: false
    };
  }
  
  // Handle content QA - asking questions about document content
  if (/\b(what.*say|what.*state|what.*mention|what.*discuss|explain|describe|summarize|what.*about.*content)\b/i.test(q) ||
      /\b(content|information|details|facts|data)\b.*\b(in|about|regarding)\b/i.test(q)) {
    console.log('   Matched ContentQA pattern');
    return {
      intent: 'ContentQA',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  // Handle linked documents - asking about relationships
  if (/\b(linked|related|connected|associated|versions?|previous|next|later|earlier)\b/i.test(q) ||
      /\b(relations?|connections?|references?|citations?)\b/i.test(q)) {
    console.log('   Matched Linked pattern');
    return {
      intent: 'Linked',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  // Handle preview requests - wanting to see document content
  if (/\b(preview|show|view|see|look).*\b(document|file|content)\b/i.test(q) ||
      /\b(open|display|render)\b/i.test(q)) {
    console.log('   Matched Preview pattern');
    return {
      intent: 'Preview',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  // Handle timeline requests - chronological queries
  if (/\b(timeline|chronological|over.*time|history)\b/i.test(q) ||
      /\b(when.*happen|sequence.*events|order.*occurred)\b/i.test(q)) {
    console.log('   Matched Timeline pattern');
    return {
      intent: 'Timeline',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  // Handle extraction requests - structured data extraction
  if (/\b(extract|pull|get|gather|collect).*\b(fields?|data|information)\b/i.test(q) ||
      /\b(table|spreadsheet|csv|json|structured)\b/i.test(q)) {
    console.log('   Matched Extract pattern');
    return {
      intent: 'Extract',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  // Handle analysis requests - deeper document analysis
  if (/\b(analy(z|s)e|compare|contrast|evaluate|assess|review)\b/i.test(q) ||
      /\b(insights?|findings?|conclusions?|recommendations?)\b/i.test(q)) {
    console.log('   Matched Analysis pattern');
    return {
      intent: 'Analysis',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.5,
      needsClarification: false
    };
  }
  
  // Handle financial document processing
  if (/\b(financial|invoice|bill|payment|amount|due|total|budget|expense|revenue)\b/i.test(q) ||
      /\b(financial|invoice|bill|payment|amount|due|total|budget|expense|revenue)\b/i.test(ctx || '')) {
    console.log('   Matched Financial pattern');
    return {
      intent: 'Financial',
      agentType: 'financial',
      agentName: 'Financial Agent',
      confidence: 0.6,
      needsClarification: false
    };
  }
  
  // Handle legal document processing
  if (/\b(legal|contract|agreement|law|liability|compliance|clause|section)\b/i.test(q) ||
      /\b(legal|contract|agreement|law|liability|compliance|clause|section)\b/i.test(ctx || '')) {
    console.log('   Matched Legal pattern');
    return {
      intent: 'Legal',
      agentType: 'legal',
      agentName: 'Legal Agent',
      confidence: 0.6,
      needsClarification: false
    };
  }
  
  // Handle resume/CV processing
  if (/\b(resume|cv|candidate|applicant|skills?|experience|education|qualification)\b/i.test(q) ||
      /\b(resume|cv|candidate|applicant|skills?|experience|education|qualification)\b/i.test(ctx || '')) {
    console.log('   Matched Resume pattern');
    return {
      intent: 'Resume',
      agentType: 'resume',
      agentName: 'Resume Agent',
      confidence: 0.6,
      needsClarification: false
    };
  }
  
  // Default to content QA for general questions
  console.log('   Defaulting to ContentQA');
  return {
    intent: 'ContentQA',
    agentType: 'content',
    agentName: 'Content Agent',
    confidence: 0.5,
    needsClarification: false
  };
}

// Test the enhanced fallback classification
const testCases = [
  'hey bro',
  'hi there',
  'what\'s up?',
  'how are you?',
  'thanks!',
  'yes',
  'no',
  'What is the title of the Microsoft contract?',
  'Show me documents from Acme Corporation',
  'Extract payment terms from the agreement'
];

console.log('🧪 Enhanced Fallback Classification Test\n');

for (const testCase of testCases) {
  console.log(`📝 Testing: "${testCase}"`);
  const result = enhancedFallbackClassification(testCase, []);
  console.log(`   Intent: ${result.intent}`);
  console.log(`   Agent: ${result.agentName}`);
  console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
  console.log(`   Status: ${result.confidence > 0.7 ? '✅ HIGH CONFIDENCE' : result.confidence > 0.5 ? '⚠️  MODERATE CONFIDENCE' : '❌ LOW CONFIDENCE'}`);
  console.log('');
}

console.log('✨ Enhanced Fallback Classification Test Complete!');