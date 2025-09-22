#!/usr/bin/env node

/**
 * Debug router functionality
 * Run with: node debug-router.js
 */

import { routeQuestion, expandQuery, extractEntities } from '../src/agents/router.js';

async function debugRouter() {
  console.log('🐛 Debug Router Test\n');
  
  const testQuestion = 'What is the title of the contract from Microsoft?';
  
  console.log(`Question: "${testQuestion}"`);
  
  try {
    // Test individual functions
    console.log('\n1. Testing classifyIntent...');
    const { classifyIntent } = await import('../src/agents/router.js');
    
    // Manually test the regex patterns
    const q = testQuestion.toLowerCase();
    console.log('Question (lowercase):', q);
    
    // Test metadata query pattern
    const metadataPattern1 = /\b(what.*about|tell.*about|info.*about|details.*about|metadata.*for|properties.*of|characteristics.*of)\b/i;
    const metadataPattern2 = /\b(title|subject|sender|receiver|date|category|type|filename|document.*type|file.*type)\b.*\b(of|for|about)\b/i;
    const metadataPattern3 = /\b(list|show|find|search).*\b(documents?|files?)\b/i;
    
    console.log('Pattern 1 match:', metadataPattern1.test(q));
    console.log('Pattern 2 match:', metadataPattern2.test(q));
    console.log('Pattern 3 match:', metadataPattern3.test(q));
    
    // Test specific patterns in the question
    console.log('Contains "what":', q.includes('what'));
    console.log('Contains "title":', q.includes('title'));
    console.log('Contains "of":', q.includes('of'));
    
    // Test the actual classification
    const result = classifyIntent(testQuestion, '');
    console.log('Classify result:', result);
    
    // Test full routing
    console.log('\n2. Testing full routing...');
    const fullResult = await routeQuestion(testQuestion, []);
    console.log('Full routing result:', JSON.stringify(fullResult, null, 2));
    
  } catch (error) {
    console.log('Error:', error.message);
    console.log('Stack:', error.stack);
  }
  
  console.log('\n✨ Debug Complete!');
}

debugRouter().catch(console.error);