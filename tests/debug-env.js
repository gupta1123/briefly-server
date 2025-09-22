#!/usr/bin/env node

/**
 * Debug script to check environment variables
 * Run with: node debug-env.js
 */

async function debugEnv() {
  console.log('🔍 Environment Variable Debug\n');
  
  // Check environment variables
  console.log('1. Environment Variables:');
  console.log('   GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✅ FOUND' : '❌ NOT FOUND');
  console.log('   GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? '✅ FOUND' : '❌ NOT FOUND');
  
  if (process.env.GEMINI_API_KEY) {
    console.log('   GEMINI_API_KEY Length:', process.env.GEMINI_API_KEY.length);
    console.log('   GEMINI_API_KEY Prefix:', process.env.GEMINI_API_KEY.substring(0, 10) + '...');
  }
  
  if (process.env.GOOGLE_API_KEY) {
    console.log('   GOOGLE_API_KEY Length:', process.env.GOOGLE_API_KEY.length);
    console.log('   GOOGLE_API_KEY Prefix:', process.env.GOOGLE_API_KEY.substring(0, 10) + '...');
  }
  
  // Check if we can import the ai module
  console.log('\n2. AI Module Test:');
  try {
    const { ai } = await import('../src/ai.js');
    console.log('   ✅ AI module imported successfully');
    
    // Test if API key is properly configured in the ai module
    console.log('   AI module model:', ai.model);
    
  } catch (error) {
    console.log('   ❌ AI module import failed:', error.message);
  }
  
  // Check the actual .env file
  console.log('\n3. .env File Check:');
  try {
    const fs = await import('fs');
    const path = await import('path');
    
    const envPath = path.join(process.cwd(), '.env');
    const envLocalPath = path.join(process.cwd(), '.env.local');
    
    if (fs.existsSync(envPath)) {
      console.log('   ✅ .env file exists');
      const envContent = fs.readFileSync(envPath, 'utf8');
      console.log('   .env content:');
      envContent.split('\n').forEach(line => {
        if (line.trim() && !line.startsWith('#')) {
          console.log('     ', line);
        }
      });
    } else {
      console.log('   ❌ .env file not found');
    }
    
    if (fs.existsSync(envLocalPath)) {
      console.log('   ✅ .env.local file exists');
      const envLocalContent = fs.readFileSync(envLocalPath, 'utf8');
      console.log('   .env.local content:');
      envLocalContent.split('\n').forEach(line => {
        if (line.trim() && !line.startsWith('#')) {
          console.log('     ', line);
        }
      });
    } else {
      console.log('   ❌ .env.local file not found');
    }
    
  } catch (error) {
    console.log('   ❌ File check failed:', error.message);
  }
  
  console.log('\n✨ Debug Complete!');
}

debugEnv().catch(console.error);
