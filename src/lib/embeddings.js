/**
 * Generate embedding for text using OpenAI API
 * @param {string} text - Text to embed
 * @returns {Array|null} Embedding vector or null if failed
 */
export async function generateEmbedding(text) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('OpenAI API key not configured for embeddings');
      return null;
    }
    
    // Clean and truncate text if too long
    const cleanedText = String(text || '').trim();
    if (!cleanedText) return null;
    const cached = getCache(cleanedText);
    if (cached) return cached;
    
    // OpenAI has a limit of 8192 tokens for text-embedding-3-small
    // Roughly estimate token count (4 chars = 1 token)
    const maxChars = 30000; // Safe limit
    const truncatedText = cleanedText.length > maxChars 
      ? cleanedText.substring(0, maxChars) 
      : cleanedText;
    
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        model: 'text-embedding-3-small', 
        input: truncatedText 
      }),
    });
    
    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      console.error(`OpenAI embeddings error: ${res.status} ${errTxt}`);
      return null;
    }
    
    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;
    if (embedding) setCache(cleanedText, embedding, 5 * 60_000);
    
    return Array.isArray(embedding) ? embedding : null;
  } catch (error) {
    console.error('Embedding generation failed:', error);
    return null;
  }
}

// Simple in-memory cache for embeddings
const _cache = new Map();
function getCache(key){
  const v = _cache.get(key);
  if (!v) return null; if (Date.now() > v.exp) { _cache.delete(key); return null; }
  return v.data;
}
function setCache(key, data, ttlMs){ _cache.set(key, { data, exp: Date.now()+ttlMs }); }
