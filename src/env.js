export function loadEnv() {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET,
    GEMINI_API_KEY,
    OPENAI_API_KEY,
    PORT,
  } = process.env;

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_JWT_SECRET) missing.push('SUPABASE_JWT_SECRET');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);

  return {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET,
    GEMINI_API_KEY,
    OPENAI_API_KEY,
    PORT: Number(PORT || 8787),
  };
}