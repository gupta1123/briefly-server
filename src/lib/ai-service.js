import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/googleai';
import { retryWithBackoff, shouldRetryError } from './retry-service.js';

// Rate limiting constants - Updated for Gemini 2.0 Flash Pay-as-You-Go Tier 1
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30000; // Gemini 2.0 Flash Tier 1: 30,000 RPM
const MAX_CONCURRENT_REQUESTS = 50; // Increased from 5 for better throughput
const BACKOFF_BASE_DELAY = 1000; // 1 second
const MAX_RETRIES = 3;

// Rate limiting tracking
const requestTimestamps = [];
let activeRequests = 0;

// Usage tracking for monitoring
const usageStats = {
  totalRequests: 0,
  totalTokens: 0,
  errors: 0,
  startTime: Date.now()
};

// Provider backoff (e.g., from RetryInfo on 429)
let providerBackoffUntil = 0; // ms epoch

function setProviderBackoffUntil(tsMs) {
  const next = Number(tsMs || 0);
  if (!isFinite(next)) return;
  providerBackoffUntil = Math.max(providerBackoffUntil, next);
}

function setProviderBackoffFromError(error) {
  try {
    // Default to 30s if not provided
    let delayMs = 30_000;
    // Try to parse RetryInfo.retryDelay like '18s'
    const info = error?.errorDetails?.find?.((d) => (d['@type'] || '').includes('RetryInfo'));
    if (info?.retryDelay) {
      const m = String(info.retryDelay).match(/^(\d+)(s|ms)?$/i);
      if (m) {
        const val = Number(m[1]);
        delayMs = m[2] && m[2].toLowerCase() === 'ms' ? val : val * 1000;
      }
    }
    // Also handle message text containing 'RetryInfo' or generic 429
    const now = Date.now();
    setProviderBackoffUntil(now + delayMs);
  } catch {}
}

function getProviderBackoffUntil() { return providerBackoffUntil; }
function isProviderBackedOff() { return Date.now() < providerBackoffUntil; }

/**
 * Check if we're within rate limits
 * @returns {boolean} Whether we can make a request
 */
function canMakeRequest() {
  // Respect provider backoff windows (e.g., 429 RetryInfo)
  if (isProviderBackedOff()) return false;
  const now = Date.now();
  // Remove timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }
  
  // Check if we're under the limit
  return requestTimestamps.length < MAX_REQUESTS_PER_WINDOW && activeRequests < MAX_CONCURRENT_REQUESTS;
}

/**
 * Add a request timestamp
 */
function addRequestTimestamp() {
  requestTimestamps.push(Date.now());
}

/**
 * Track usage statistics
 */
function trackUsage(tokens = 0, isError = false) {
  usageStats.totalRequests++;
  usageStats.totalTokens += tokens;
  if (isError) usageStats.errors++;
}

/**
 * Get current usage statistics
 */
function getUsageStats() {
  const uptime = Date.now() - usageStats.startTime;
  const uptimeMinutes = uptime / (1000 * 60);
  
  return {
    ...usageStats,
    uptimeMinutes: Math.round(uptimeMinutes),
    requestsPerMinute: Math.round(usageStats.totalRequests / uptimeMinutes),
    tokensPerMinute: Math.round(usageStats.totalTokens / uptimeMinutes),
    errorRate: usageStats.totalRequests > 0 ? (usageStats.errors / usageStats.totalRequests * 100).toFixed(2) + '%' : '0%'
  };
}

/**
 * Safe LLM call with rate limiting and retry logic
 * @param {Function} callFunction - Function that makes the LLM call
 * @param {Object} options - Options for the call
 * @returns {Promise} Promise that resolves with the LLM response
 */
async function safeLLMCall(callFunction, options = {}) {
  const { maxRetries = MAX_RETRIES, onRetry, onError } = options;
  
  // Check rate limits first
  if (!canMakeRequest()) {
    const error = new Error('Rate limit exceeded. Please try again later.');
    error.code = 'RATE_LIMIT_EXCEEDED';
    throw error;
  }
  
  activeRequests++;
  
  try {
    const result = await retryWithBackoff(
      async (attempt) => {
        // Add timestamp before making request
        addRequestTimestamp();
        const response = await callFunction();
        // Track successful usage (estimate tokens if not provided)
        trackUsage(response?.usage?.total_tokens || 100, false);
        return response;
      },
      {
        maxRetries,
        baseDelay: BACKOFF_BASE_DELAY,
        shouldRetry: shouldRetryError,
        onRetry: (attempt, delay, error) => {
          console.log(`🔄 Retrying AI call (attempt ${attempt + 1}) in ${delay}ms: ${error.message}`);
          if (onRetry) onRetry(attempt, delay, error);
        }
      }
    );
    return result;
  } catch (error) {
    // Track error usage
    trackUsage(0, true);
    // On clear provider 429, set a backoff window so future calls short-circuit quickly
    try {
      if (error?.status === 429 || /Too Many Requests/i.test(String(error?.statusText || error?.message || ''))) {
        setProviderBackoffFromError(error);
      }
    } catch {}
    if (onError) onError(error);
    throw error;
  } finally {
    activeRequests--;
  }
}

/**
 * Initialize AI service with rate limiting
 */
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// Validate API key
if (!API_KEY) {
  console.warn('⚠️  Gemini API key not configured. AI features will be limited.');
}

const ai = genkit({
  plugins: [googleAI({ apiKey: API_KEY })],
  model: 'googleai/gemini-2.0-flash',
});

/**
 * Generate text with rate limiting and error handling
 * @param {Object} options - Generation options
 * @returns {Promise} Promise that resolves with the generated text
 */
async function generateText(options) {
  // If no API key, return fallback response
  if (!API_KEY) {
    return {
      text: 'AI service is not configured. Please contact your administrator.',
      fallback: true
    };
  }
  
  try {
    return await safeLLMCall(async () => {
      const response = await ai.generate({
        ...options,
        model: options.model || 'googleai/gemini-2.0-flash'
      });
      let text = '';
      if (typeof response === 'string') text = response;
      else if (response && typeof response.text === 'string') text = response.text;
      else if (response && typeof response.toString === 'function') text = response.toString();
      else text = JSON.stringify(response);
      return { text };
    }, {
      maxRetries: MAX_RETRIES,
      onRetry: (attempt, delay, error) => {
        console.log(`🔄 Retrying AI call (attempt ${attempt + 1}): ${error.message}`);
      },
      onError: (error) => {
        console.error('❌ AI call failed after all retries:', error);
      }
    });
  } catch (primaryErr) {
    // Fallback to OpenAI Chat Completions if available
    try {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw primaryErr;
      const prompt = typeof options.prompt === 'string' ? options.prompt : JSON.stringify(options.prompt);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: (options.temperature ?? 0.3)
        })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`OpenAI fallback failed: ${res.status} ${txt}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      return { text };
    } catch (fallbackErr) {
      // Record provider backoff on primary 429 to avoid thrash
      try {
        if (primaryErr?.status === 429 || /Too Many Requests/i.test(String(primaryErr?.statusText || primaryErr?.message || ''))) {
          setProviderBackoffFromError(primaryErr);
        }
      } catch {}
      console.error('❌ Both primary and fallback generation failed:', fallbackErr);
      throw primaryErr;
    }
  }
}

/**
 * Define prompt with rate limiting
 * @param {Object} promptConfig - Prompt configuration
 * @returns {Promise} Promise that resolves with the prompt function
 */
function definePrompt(promptConfig) {
  return ai.definePrompt(promptConfig);
}

export {
  ai,
  generateText,
  definePrompt,
  safeLLMCall,
  canMakeRequest,
  getUsageStats,
  trackUsage,
  // Backoff helpers for router/degradation
  setProviderBackoffUntil,
  setProviderBackoffFromError,
  getProviderBackoffUntil,
  isProviderBackedOff
};

export default {
  ai,
  generateText,
  definePrompt,
  safeLLMCall,
  canMakeRequest,
  getUsageStats,
  trackUsage,
  setProviderBackoffUntil,
  setProviderBackoffFromError,
  getProviderBackoffUntil,
  isProviderBackedOff
};
