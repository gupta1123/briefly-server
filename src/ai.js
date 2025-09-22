import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/googleai';
import { canMakeRequest } from './lib/ai-service.js';

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// Check if we can make requests before initializing
if (API_KEY && !canMakeRequest()) {
  console.warn('⚠️  Rate limit may be exceeded. AI requests will be throttled.');
}

export const ai = genkit({
  plugins: [googleAI({ apiKey: API_KEY })],
  model: 'googleai/gemini-2.0-flash',
});

// Export the rate-limited service as well
export { default as aiService } from './lib/ai-service.js';