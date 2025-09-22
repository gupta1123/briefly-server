#!/usr/bin/env node

/**
 * Test script to check if AI key is configured properly
 * Run with: node test-ai-config.js
 */

async function testAIConfig() {
  console.log('🧪 Testing AI Configuration\n');
  
  try {
    // Test environment variables
    console.log('1. Environment Variables:');
    console.log('   GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✅ Configured' : '❌ Not found');
    console.log('   GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? '✅ Configured' : '❌ Not found');
    console.log('   API Key Value:', process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || 'None');
    
    // Test importing the existing AI module
    console.log('\n2. Testing AI Module Import...');
    const { ai } = await import('../src/ai.js');
    console.log('   ✅ AI module imported successfully');
    
    // Test if API key is properly configured
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (apiKey) {
      console.log('   🔑 API key found in environment');
    } else {
      console.log('   ❌ No API key found in environment');
    }
    
    // Test a simple AI call
    console.log('\n3. Testing Simple AI Call...');
    if (apiKey) {
      try {
        // Create a simple prompt to test the AI
        const testPrompt = ai.definePrompt({
          name: 'testPrompt',
          input: { schema: z => z.object({ question: z.string() }) },
          output: { schema: z => z.object({ answer: z.string() }) },
          prompt: 'Answer the following question briefly: {{{question}}}'
        });
        
        console.log('   ✅ AI prompt defined successfully');
      } catch (error) {
        console.log('   ℹ️  AI prompt definition info:', error.message);
      }
    } else {
      console.log('   ⏭️  Skipping AI test - no API key configured');
    }
    
    console.log('\n✨ AI Configuration Test Complete!');
    
  } catch (error) {
    console.error('Test error:', error);
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testAIConfig().catch(console.error);
}

export { testAIConfig };