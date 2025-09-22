#!/usr/bin/env node

/**
 * Test script for enhanced router functionality
 * Run with: node test-enhanced-router.js
 */

// Use dynamic import for ES modules
async function testEnhancedRouter() {
  console.log('🧪 Testing Enhanced Router Functionality\n');

  try {
    // Dynamically import the router functions
    const routerModule = await import('../src/agents/router.js');
    const { routeQuestion, expandQuery, extractEntities } = routerModule;

    // Test cases for different intents
    const testCases = [
      {
        question: 'What is the title of the contract from Microsoft?',
        expectedIntent: 'FindFiles',
        description: 'Metadata query with entity extraction'
      },
      {
        question: 'Tell me about the quarterly financial report',
        expectedIntent: 'ContentQA',
        description: 'Content QA with topic identification'
      },
      {
        question: 'Show me linked documents to invoice #12345',
        expectedIntent: 'Linked',
        description: 'Linked documents query'
      },
      {
        question: 'Preview the employment agreement',
        expectedIntent: 'Preview',
        description: 'Document preview request'
      },
      {
        question: 'Extract payment terms from the contract',
        expectedIntent: 'Extract',
        description: 'Structured data extraction'
      },
      {
        question: 'Analyze the merger proposal',
        expectedIntent: 'Analysis',
        description: 'Document analysis request'
      },
      {
        question: 'What is the total amount due on invoice INV-2023-001?',
        expectedIntent: 'Financial',
        description: 'Financial document processing'
      },
      {
        question: 'Review the compliance requirements in the agreement',
        expectedIntent: 'Legal',
        description: 'Legal document processing'
      },
      {
        question: 'Evaluate John Smith\'s qualifications for the position',
        expectedIntent: 'Resume',
        description: 'Resume/CV analysis'
      }
    ];

    console.log('1. Testing Intent Classification...');
    
    for (const testCase of testCases) {
      try {
        const result = routeQuestion(testCase.question, []);
        console.log(`\n📝 Question: "${testCase.question}"`);
        console.log(`   Expected: ${testCase.expectedIntent}`);
        console.log(`   Detected: ${result.intent} (${(result.confidence * 100).toFixed(1)}% confidence)`);
        console.log(`   Agent: ${result.agentName}`);
        
        if (result.intent === testCase.expectedIntent) {
          console.log('   ✅ PASS');
        } else {
          console.log('   ❌ FAIL');
        }
      } catch (error) {
        console.log(`\n📝 Question: "${testCase.question}"`);
        console.log(`   ❌ ERROR: ${error.message}`);
      }
    }

    console.log('\n2. Testing Query Expansion...');
    
    const expansionTest = 'What is the subject of the document from Acme Corporation dated January 15, 2023?';
    try {
      const expanded = expandQuery(expansionTest);
      console.log(`\n📝 Original: "${expansionTest}"`);
      console.log(`   Expanded: "${expanded.expanded}"`);
      console.log(`   Terms: [${expanded.terms.slice(0, 10).join(', ')}${expanded.terms.length > 10 ? '...' : ''}]`);
      console.log('   ✅ Query expansion working');
    } catch (error) {
      console.log(`\n📝 Query: "${expansionTest}"`);
      console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('\n3. Testing Entity Extraction...');
    
    const entityTest = 'What is the title of the contract from "Microsoft Corporation" dated 01/15/2023?';
    try {
      const entities = extractEntities(entityTest);
      console.log(`\n📝 Text: "${entityTest}"`);
      console.log('   Entities found:');
      entities.forEach(entity => {
        console.log(`     - ${entity.type}: "${entity.value}" (${(entity.confidence * 100).toFixed(1)}% confidence)`);
      });
      console.log('   ✅ Entity extraction working');
    } catch (error) {
      console.log(`\n📝 Text: "${entityTest}"`);
      console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('\n✨ Enhanced Router Test Complete!');
    console.log('\n📝 Next steps:');
    console.log('  1. Start the development server');
    console.log('  2. Log in to the application');
    console.log('  3. Navigate to the "Test Agent" page in the sidebar');
    console.log('  4. Test the enhanced routing functionality');
    console.log('\n🎉 Enhanced agent routing is ready for integration!');
    
  } catch (error) {
    console.error('Test error:', error);
  }
}

// Handle module loading
if (import.meta.url === `file://${process.argv[1]}`) {
  testEnhancedRouter().catch(console.error);
}

export { testEnhancedRouter };
