#!/usr/bin/env node

/**
 * Agent Router Test with Loaded Environment Variables
 * Run with: node test-agent-router-with-env.js
 */

// Explicitly load environment variables
import 'dotenv/config';

console.log('🧪 Agent Router Test with Environment Variables\n');

// Test 1: Check environment variables
console.log('1. Environment Variables Check:');
console.log('   GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? `✅ FOUND (${process.env.GEMINI_API_KEY.substring(0, 10)}...)` : '❌ NOT FOUND');

// Test 2: Import and test the agent router
console.log('\n2. Agent Router Import Test:');
try {
  const { routeQuestion } = await import('../src/agents/ai-router.js');
  console.log('   ✅ Agent router imported successfully');
  
  // Test 3: Simple routing test
  console.log('\n3. Simple Routing Test:');
  const testQuestion = 'What is the title of the Microsoft contract?';
  console.log('   Question:', testQuestion);
  
  try {
    const result = await routeQuestion(testQuestion, []);
    console.log('   Routing result:', JSON.stringify(result, null, 2));
    console.log('   ✅ Routing test passed');
  } catch (error) {
    console.log('   ❌ Routing test failed:', error.message);
  }
  
} catch (error) {
  console.log('   ❌ Agent router import failed:', error.message);
}

console.log('\n✨ Agent Router Test Complete!');