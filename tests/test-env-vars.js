#!/usr/bin/env node

/**
 * Environment Variable Test
 * Run with: node test-env-vars.js
 */

// Explicitly load environment variables
import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

console.log('🧪 Environment Variable Test\n');

// Test 1: Check if dotenv is working
console.log('1. Dotenv Configuration:');
console.log('   NODE_ENV:', process.env.NODE_ENV || 'undefined');
console.log('   PORT:', process.env.PORT || 'undefined');

// Test 2: Check if API keys are loaded
console.log('\n2. API Key Configuration:');
console.log('   GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? `✅ FOUND (${process.env.GEMINI_API_KEY.substring(0, 10)}...)` : '❌ NOT FOUND');
console.log('   GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? `✅ FOUND (${process.env.GOOGLE_API_KEY.substring(0, 10)}...)` : '❌ NOT FOUND');
console.log('   OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? `✅ FOUND (${process.env.OPENAI_API_KEY.substring(0, 10)}...)` : '❌ NOT FOUND');

// Test 3: Check if Supabase keys are loaded
console.log('\n3. Supabase Configuration:');
console.log('   SUPABASE_URL:', process.env.SUPABASE_URL ? `✅ FOUND (${process.env.SUPABASE_URL.substring(0, 30)}...)` : '❌ NOT FOUND');
console.log('   SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✅ FOUND' : '❌ NOT FOUND');
console.log('   SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ FOUND' : '❌ NOT FOUND');

// Test 4: Check if .env files exist
console.log('\n4. .env File Check:');
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const envPath = join(process.cwd(), '.env');
const envLocalPath = join(process.cwd(), '.env.local');

if (existsSync(envPath)) {
  console.log('   ✅ .env file exists');
  try {
    const envContent = readFileSync(envPath, 'utf8');
    const lines = envContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
    console.log('   .env entries:', lines.length);
    lines.forEach(line => {
      if (line.includes('KEY=') || line.includes('SECRET=')) {
        const [key, value] = line.split('=');
        console.log(`     ${key}=${value.substring(0, 10)}...${value.length > 10 ? value.substring(value.length - 5) : ''}`);
      }
    });
  } catch (error) {
    console.log('   ❌ Error reading .env:', error.message);
  }
} else {
  console.log('   ❌ .env file not found');
}

if (existsSync(envLocalPath)) {
  console.log('   ✅ .env.local file exists');
  try {
    const envLocalContent = readFileSync(envLocalPath, 'utf8');
    const lines = envLocalContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
    console.log('   .env.local entries:', lines.length);
    lines.forEach(line => {
      if (line.includes('KEY=') || line.includes('SECRET=')) {
        const [key, value] = line.split('=');
        console.log(`     ${key}=${value.substring(0, 10)}...${value.length > 10 ? value.substring(value.length - 5) : ''}`);
      }
    });
  } catch (error) {
    console.log('   ❌ Error reading .env.local:', error.message);
  }
} else {
  console.log('   ❌ .env.local file not found');
}

console.log('\n✨ Environment Variable Test Complete!');
console.log('\n📝 Next steps:');
console.log('  1. Ensure API keys are properly configured in .env or .env.local');
console.log('  2. Restart the server to pick up new environment variables');
console.log('  3. Test the enhanced agent functionality');