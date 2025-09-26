import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { jsonrepair } from 'jsonrepair';
import { GoogleAuth } from 'google-auth-library';

// Support both API key and OAuth2 credentials
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

let genAI = null;
let fileManager = null;

// Check for OAuth2 and initialize accordingly  
if (GOOGLE_CREDENTIALS_JSON) {
  console.info('OAuth2 credentials found - configuring service account authentication');
  try {
    const credentials = typeof GOOGLE_CREDENTIALS_JSON === 'string' 
      ? JSON.parse(GOOGLE_CREDENTIALS_JSON)
      : GOOGLE_CREDENTIALS_JSON;
    
    // Set credentials as Google Default Application Credentials
    // This is the standard way for service account authentication
    process.env.GOOGLE_APPLICATION_CREDENTIALS = Buffer.from(JSON.stringify(credentials)).toString('base64');
    
    // Disable API key to force OAuth2
    genAI = new GoogleGenerativeAI();
    fileManager = new GoogleAIFileManager('');
    
    console.info('Using OAuth2 service account authentication');
  } catch (error) {
    console.error('OAuth2 initialization error:', error.message);
  }
}

// Fall back to API key if OAuth2 failed or not available
if (!genAI && API_KEY) {
  genAI = new GoogleGenerativeAI(API_KEY);
  fileManager = new GoogleAIFileManager(API_KEY);
  console.info('Using API key authentication');
}

if (!genAI || !fileManager) {
  console.warn('Gemini client not configured. Check credentials.');
}

export async function uploadBufferToGemini(buffer, { mimeType, displayName }) {
  if (!fileManager) throw new Error('Gemini FileManager not configured');
  const upload = await fileManager.uploadFile(buffer, {
    mimeType: mimeType || 'application/octet-stream',
    displayName: displayName || 'document',
  });
  const file = upload?.file;
  if (!file?.uri || !file?.name) {
    throw new Error('Gemini upload did not return a usable file reference');
  }
  return {
    fileId: file.name,
    fileUri: file.uri,
    mimeType: mimeType || file.mimeType || 'application/octet-stream',
  };
}

export async function deleteGeminiFile(fileId) {
  if (!fileManager || !fileId) return;
  try {
    await fileManager.deleteFile(fileId);
  } catch (error) {
    console.warn('Failed to delete Gemini file', fileId, error?.message || error);
  }
}

export async function generateJsonFromGeminiFile({ fileUri, mimeType, prompt, responseMimeType = 'application/json', responseSchema, responseJsonSchema }) {
  if (!genAI) throw new Error('Gemini client not configured');
  if (responseSchema && responseJsonSchema) {
    throw new Error('Provide either responseSchema or responseJsonSchema, not both.');
  }

  const generationConfig = { responseMimeType };
  if (responseSchema) generationConfig.responseSchema = responseSchema;
  if (responseJsonSchema) generationConfig.responseJsonSchema = responseJsonSchema;

  const model = genAI.getGenerativeModel({
    model: 'models/gemini-2.0-flash',
    generationConfig,
  });
  const result = await model.generateContent([
    { fileData: { fileUri, mimeType } },
    { text: prompt },
  ]);
  const raw = result?.response?.text?.();
  if (!raw) {
    throw new Error('Gemini response empty');
  }

  const tryParse = (value) => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (err) {
      // Gemini occasionally emits stray backslashes (e.g. \\ or lone \ before non-escape chars).
      // Escape any invalid sequences and try again before giving up.
      const sanitized = value.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
      if (sanitized !== value) {
        try {
          return JSON.parse(sanitized);
        } catch {}
      }
      throw err;
    }
  };

  const parseJsonSafely = (input) => {
    if (!input) return null;
    const trimmed = input.trim();

    // Try plain JSON first
    try {
      return tryParse(trimmed);
    } catch {}

    // Look for fenced code blocks ```json ... ```
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return tryParse(fenced[1].trim());
      } catch {}
    }

    // Fallback: grab the first {...} section
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return tryParse(candidate);
      } catch {}
    }

    // Fallback: Gemini sometimes returns multiple JSON objects separated by commas.
    try {
      const merged = tryParse(`[${trimmed}]`);
      if (Array.isArray(merged) && merged.length > 0) {
        return Object.assign({}, ...merged);
      }
    } catch {}

    // Last resort: attempt to repair almost-valid JSON before failing.
    try {
      return tryParse(jsonrepair(trimmed));
    } catch {}

    return null;
  };

  const parsed = parseJsonSafely(raw);
  if (parsed !== null) {
    return parsed;
  }

  console.error('Gemini JSON parse failure. Response was:', raw);
  const error = new SyntaxError('Gemini returned non-JSON response');
  error.rawResponse = raw;
  throw error;
}

export function hasGeminiClient() {
  return Boolean(genAI && fileManager);
}

