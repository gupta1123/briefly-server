import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

if (!API_KEY) {
  console.warn('Gemini API key not configured. Calls will fail until GEMINI_API_KEY or GOOGLE_API_KEY is set.');
}

const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;
const fileManager = API_KEY ? new GoogleAIFileManager(API_KEY) : null;

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

export async function generateJsonFromGeminiFile({ fileUri, mimeType, prompt, responseMimeType = 'application/json' }) {
  if (!genAI) throw new Error('Gemini client not configured');
  const model = genAI.getGenerativeModel({
    model: 'models/gemini-1.5-flash',
    generationConfig: { responseMimeType },
  });
  const result = await model.generateContent([
    { fileData: { fileUri, mimeType } },
    { text: prompt },
  ]);
  const raw = result?.response?.text?.();
  if (!raw) {
    throw new Error('Gemini response empty');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('Gemini JSON parse failure. Response was:', raw);
    throw error;
  }
}

export function hasGeminiClient() {
  return Boolean(genAI && fileManager);
}
