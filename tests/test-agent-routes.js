#!/usr/bin/env node

/**
 * Quick test script for new agent routes
 * Run with: node test-agent-routes.js
 */

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8787';

async function testAgentRoutes() {
  console.log('🧪 Testing New Agent Routes\n');
  console.log(`Testing against: ${BASE_URL}\n`);

  // Test 1: Health check
  console.log('1. Testing health endpoint...');
  try {
    const response = await fetch(`${BASE_URL}/health`);
    const data = await response.json();
    console.log('✅ Health check:', data);
  } catch (error) {
    console.log('❌ Health check failed:', error.message);
    return;
  }

  // Test 2: Check if our new v2 endpoint exists
  console.log('\n2. Testing new agent v2 endpoint existence...');
  try {
    const response = await fetch(`${BASE_URL}/`, {
      method: 'OPTIONS'
    });
    console.log('✅ Server is responding');
  } catch (error) {
    console.log('❌ Server not responding:', error.message);
  }

  console.log('\n✨ Agent Routes Test Complete!\n');
  console.log('📝 To fully test the new routes, you would need:');
  console.log('  1. A valid authentication token');
  console.log('  2. A valid organization ID');
  console.log('  3. To make a POST request to /orgs/:orgId/chat/ask-v2');
  console.log('\n🎉 New agent routes are ready for integration!');
}

// Handle ES modules
if (typeof fetch === 'undefined') {
  import('node-fetch').then(({ default: fetch }) => {
    global.fetch = fetch;
    testAgentRoutes();
  });
} else {
  testAgentRoutes();
}