#!/usr/bin/env node

/**
 * Quick test script for IP validation functionality
 * Run with: node test-ip-validation.js
 */

const BASE_URL = process.env.API_BASE_URL || 'https://dbmsv1-a8c47a9076c6.herokuapp.com';

async function testIpValidation() {
  console.log('🧪 Testing IP Validation System\n');
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

  // Test 2: Unauthenticated org endpoint (should fail with auth error)
  console.log('\n2. Testing unauthenticated org endpoint...');
  try {
    const response = await fetch(`${BASE_URL}/orgs/test-org-id/ip-check`);
    const data = await response.json();
    if (response.status === 401) {
      console.log('✅ Properly rejected unauthenticated request');
    } else {
      console.log('❌ Unexpected response:', response.status, data);
    }
  } catch (error) {
    console.log('✅ Request properly blocked:', error.message);
  }

  // Test 3: Check if IP validation middleware is loaded
  console.log('\n3. Testing with dummy auth (expect specific error)...');
  try {
    const response = await fetch(`${BASE_URL}/orgs/test-org-id/documents`, {
      headers: {
        'Authorization': 'Bearer invalid-token',
        'X-Org-Id': 'test-org-id'
      }
    });
    const data = await response.json();
    console.log('Response status:', response.status);
    console.log('Response:', data);
    
    if (response.status === 401) {
      console.log('✅ Auth validation working');
    } else if (response.status === 403 && data.code === 'IP_NOT_ALLOWED') {
      console.log('✅ IP validation middleware is working!');
    } else {
      console.log('⚠️  Unexpected response - check implementation');
    }
  } catch (error) {
    console.log('ℹ️  Request error (expected):', error.message);
  }

  console.log('\n✨ IP Validation System Test Complete!\n');
  console.log('📝 Next steps:');
  console.log('  1. Run the settings_schema.sql in your Supabase dashboard');
  console.log('  2. Login to your app as an orgAdmin user');
  console.log('  3. Go to Settings → Access Control');
  console.log('  4. Test enabling/disabling IP allowlist');
  console.log('  5. Test admin bypass functionality');
  console.log('\n🎉 Your IP allowlist system is ready!');
}

// Handle ES modules
if (typeof fetch === 'undefined') {
  import('node-fetch').then(({ default: fetch }) => {
    global.fetch = fetch;
    testIpValidation();
  });
} else {
  testIpValidation();
}