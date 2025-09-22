#!/usr/bin/env node

/**
 * Test enhanced routing with realistic examples
 * Run with: node test-enhanced-routing.js
 */

import { routeQuestion } from '../src/agents/ai-router.js';

async function testEnhancedRouting() {
  console.log('🧪 Enhanced Routing Test\n');
  
  // Test cases that mimic real user interactions
  const testCases = [
    {
      question: 'hey bro',
      description: 'Casual greeting (should default to ContentQA)'
    },
    {
      question: 'What is the title of the Microsoft contract?',
      description: 'Metadata query with entity extraction'
    },
    {
      question: 'Show me documents from Acme Corporation',
      description: 'FindFiles query with organization filter'
    },
    {
      question: 'Extract payment terms from the agreement',
      description: 'Extract query with document processing'
    },
    {
      question: 'Analyze the quarterly financial report',
      description: 'Analysis query with financial focus'
    }
  ];
  
  for (const testCase of testCases) {
    console.log(`📝 Testing: "${testCase.question}"`);
    console.log(`   Description: ${testCase.description}`);
    
    try {
      const result = await routeQuestion(testCase.question, []);
      console.log(`   Intent: ${result.intent}`);
      console.log(`   Agent: ${result.agentName}`);
      console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`   Status: ${result.confidence > 0.7 ? '✅ HIGH CONFIDENCE' : result.confidence > 0.5 ? '⚠️  MODERATE CONFIDENCE' : '❌ LOW CONFIDENCE'}`);
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
    }
    
    console.log('');
  }
  
  console.log('✨ Enhanced Routing Test Complete!');
}

testEnhancedRouting().catch(console.error);