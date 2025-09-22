#!/usr/bin/env node

/**
 * Simple test for router functionality
 * Run with: node simple-router-test.js
 */

import { routeQuestion, expandQuery, extractEntities } from '../src/agents/router.js';

async function simpleTest() {
  console.log('🧪 Simple Router Test\n');
  
  const testQuestion = 'What is the title of the contract from Microsoft?';
  
  console.log(`Question: "${testQuestion}"`);
  
  try {
    const result = routeQuestion(testQuestion, []);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.log('Error:', error.message);
    console.log('Stack:', error.stack);
  }
  
  console.log('\n✨ Test Complete!');
}

simpleTest().catch(console.error);