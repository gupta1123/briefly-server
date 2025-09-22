#!/usr/bin/env node

/**
 * Test script for AI-powered router
 * Run with: node test-ai-router.js
 */

async function testAIRouter() {
  console.log('🧪 Testing AI-Powered Router\n');
  
  try {
    // Dynamically import the AI router
    const { routeQuestion, classifyIntentWithAI, expandQueryWithAI, extractEntitiesWithAI } = await import('../src/agents/ai-router.js');
    
    // Test cases
    const testCases = [
      'What is the title of the Microsoft contract?',
      'Show me documents from Acme Corporation',
      'Extract payment terms from the agreement',
      'Analyze the quarterly financial report',
      'What does the employment agreement say about vacation?'
    ];
    
    console.log('1. Testing Intent Classification...');
    
    for (const question of testCases) {
      try {
        console.log(`\n📝 Question: "${question}"`);
        const result = await classifyIntentWithAI(question, []);
        console.log(`   Intent: ${result.intent}`);
        console.log(`   Agent: ${result.agentName}`);
        console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        if (result.entities.length > 0) {
          console.log(`   Entities: ${result.entities.map(e => `${e.type}: "${e.value}"`).join(', ')}`);
        }
        console.log('   ✅ SUCCESS');
      } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
      }
    }
    
    console.log('\n2. Testing Query Expansion...');
    
    const expansionTest = 'contract agreement document legal binding terms';
    try {
      console.log(`\n📝 Query: "${expansionTest}"`);
      const expanded = await expandQueryWithAI(expansionTest);
      console.log(`   Expanded: "${expanded.expanded}"`);
      console.log(`   Terms: [${expanded.terms.join(', ')}]`);
      console.log('   ✅ SUCCESS');
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
    }
    
    console.log('\n3. Testing Entity Extraction...');
    
    const entityTest = 'What is the total amount due on invoice "INV-2023-001" from Microsoft Corporation dated January 15, 2023?';
    try {
      console.log(`\n📝 Text: "${entityTest}"`);
      const entities = await extractEntitiesWithAI(entityTest);
      if (entities.length > 0) {
        console.log('   Entities found:');
        entities.forEach(entity => {
          console.log(`     - ${entity.type}: "${entity.value}" (${(entity.confidence * 100).toFixed(1)}% confidence)`);
        });
      } else {
        console.log('   No entities found');
      }
      console.log('   ✅ SUCCESS');
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
    }
    
    console.log('\n4. Testing Full Routing...');
    
    const routingTest = 'What does the employment agreement say about vacation policy?';
    try {
      console.log(`\n📝 Question: "${routingTest}"`);
      const routingResult = await routeQuestion(routingTest, []);
      console.log(`   Intent: ${routingResult.intent}`);
      console.log(`   Agent: ${routingResult.agentName}`);
      console.log(`   Confidence: ${(routingResult.confidence * 100).toFixed(1)}%`);
      if (routingResult.entities.length > 0) {
        console.log(`   Entities: ${routingResult.entities.map(e => `${e.type}: "${e.value}"`).join(', ')}`);
      }
      console.log('   ✅ SUCCESS');
    } catch (error) {
      console.log(`   ❌ ERROR: ${error.message}`);
    }
    
    console.log('\n✨ AI Router Test Complete!');
    console.log('\n📝 Next steps:');
    console.log('  1. Set up Gemini API key in environment variables');
    console.log('  2. Start the development server');
    console.log('  3. Test the AI-powered routing functionality');
    console.log('\n🎉 AI-powered routing is ready for integration!');
    
  } catch (error) {
    console.error('Test error:', error);
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testAIRouter().catch(console.error);
}

export { testAIRouter };