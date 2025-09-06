import { ai } from './ai.js';
import { z } from 'zod';

function sanitizeFilename(name) {
  try {
    const trimmed = String(name || '').trim();
    const decomp = trimmed.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const cleaned = decomp.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
    return cleaned.replace(/-+/g, '-');
  } catch {
    return 'upload.bin';
  }
}

export async function ingestDocument(app, { orgId, docId, storageKey, mimeType }) {
  const log = app.log || console;
  log.info({ orgId, docId, storageKey }, 'ingest start');

  // Get org categories to guide metadata
  let availableCategories = ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'];
  try {
    const { data: orgSettings } = await app.supabaseAdmin
      .from('org_settings')
      .select('categories')
      .eq('org_id', orgId)
      .maybeSingle();
    if (orgSettings?.categories && Array.isArray(orgSettings.categories) && orgSettings.categories.length > 0) {
      availableCategories = orgSettings.categories;
    }
  } catch {}

  // 1) Download file from Storage and build data URI
  const { data: fileBlob, error: dlErr } = await app.supabaseAdmin.storage
    .from('documents')
    .download(storageKey);
  if (dlErr || !fileBlob) {
    log.error(dlErr, 'ingest: download failed');
    return;
  }
  const arr = await fileBlob.arrayBuffer();
  const b64 = Buffer.from(arr).toString('base64');
  const ct = mimeType || fileBlob.type || 'application/octet-stream';
  const dataUri = `data:${ct};base64,${b64}`;

  // 2) Extract OCR + metadata via Gemini (Genkit)
  // Return page-aware OCR: an array of pages with text, when possible. Fallback to whole text.
  const ocrPrompt = ai.definePrompt({
    name: 'ocrPrompt',
    input: { schema: z.object({ dataUri: z.string() }) },
    output: { schema: z.object({ pages: z.array(z.object({ page: z.number().optional(), text: z.string() })).optional(), extractedText: z.string().optional() }) },
    prompt: `Extract readable text from the document, returning pages when possible.\nRespond as JSON with either {\"pages\":[{\"page\":1,\"text\":\"...\"},...] } or {\"extractedText\":\"...\"}.\n\n{{media url=dataUri}}`
  });
  const metaPrompt = ai.definePrompt({
    name: 'metaPrompt',
    input: { schema: z.object({ dataUri: z.string() }) },
    output: {
      schema: z.object({
        summary: z.string().optional(),
        keywords: z.array(z.string()).min(1).optional(),
        title: z.string().optional(),
        subject: z.string().optional(),
        sender: z.string().optional(),
        receiver: z.string().optional(),
        senderOptions: z.array(z.string()).optional(),
        receiverOptions: z.array(z.string()).optional(),
        documentDate: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).min(1).optional(),
      }),
    },
    prompt: `You are an expert document summarizer and information extractor.\n\nProvide: summary (<=300 words), subject, primary sender/receiver (+ options), documentDate, keywords (>=3), category (one of: ${availableCategories.join(', ')}), tags (3-8), title.\n\nDocument: {{media url=dataUri}}`,
  });

  let ocrText = '';
  let ocrPages = [];
  let metadata = {};
  try {
    const [{ output: ocr }, { output: meta }] = await Promise.all([
      ocrPrompt({ dataUri }),
      metaPrompt({ dataUri }),
    ]);
    const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');
    ocrPages = Array.isArray(ocr?.pages) ? ocr.pages : [];
    ocrText = ocr?.extractedText || (Array.isArray(ocrPages) ? ocrPages.map(p => p.text).join('\n\n') : '');
    metadata = {
      title: meta?.title || baseName,
      subject: meta?.subject || baseName,
      keywords: Array.from(new Set(((meta?.keywords || []).filter(Boolean).slice(0,10)).concat([baseName]))).slice(0, 10),
      tags: Array.from(new Set(((meta?.tags || []).filter(Boolean).slice(0,8)).concat(['document']))).slice(0, 8),
      summary: meta?.summary || '',
      sender: meta?.sender,
      receiver: meta?.receiver,
      documentDate: meta?.documentDate,
      category: meta?.category,
    };
  } catch (e) {
    log.warn(e, 'ingest: gemini extraction failed, continuing');
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ingest.error', doc_id: docId, note: String(e?.message || e) }); } catch {}
  }

  // Persist extraction JSON
  try {
    const key = `${orgId}/${docId}.json`;
    const payload = JSON.stringify({ ocrText, ocrPages, metadata });
    // Ensure bucket exists
    try {
      const { data: buckets } = await app.supabaseAdmin.storage.listBuckets();
      if (!buckets?.some(b => b.name === 'extractions')) {
        await app.supabaseAdmin.storage.createBucket('extractions', { public: false });
      }
    } catch {}
    await app.supabaseAdmin.storage.from('extractions').upload(key, Buffer.from(payload), { contentType: 'application/json', upsert: true });
  } catch (e) {
    log.warn(e, 'ingest: persist extraction failed');
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ingest.error', doc_id: docId, note: 'persist extraction failed' }); } catch {}
  }

  // Update document metadata only if blank (avoid stomping later edits)
  try {
    const { data: doc } = await app.supabaseAdmin
      .from('documents')
      .select('title, subject, category, tags, keywords, sender, receiver, document_date')
      .eq('org_id', orgId)
      .eq('id', docId)
      .maybeSingle();
    if (doc) {
      const payload = {};
      if (!doc.title && metadata.title) payload.title = metadata.title;
      if (!doc.subject && metadata.subject) payload.subject = metadata.subject;
      if (!doc.category && metadata.category) payload.category = metadata.category;
      if ((!doc.tags || doc.tags.length === 0) && Array.isArray(metadata.tags)) payload.tags = metadata.tags;
      if ((!doc.keywords || doc.keywords.length === 0) && Array.isArray(metadata.keywords)) payload.keywords = metadata.keywords;
      if (!doc.sender && metadata.sender) payload.sender = metadata.sender;
      if (!doc.receiver && metadata.receiver) payload.receiver = metadata.receiver;
      if (!doc.document_date && metadata.documentDate) {
        const norm = normalizeDate(metadata.documentDate);
        if (norm) payload.document_date = norm;
      }
      if (Object.keys(payload).length > 0) {
        await app.supabaseAdmin.from('documents').update(payload).eq('org_id', orgId).eq('id', docId);
      }
    }
  } catch (e) {
    log.warn(e, 'ingest: update doc metadata failed');
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ingest.error', doc_id: docId, note: 'update metadata failed' }); } catch {}
  }

  // 3) Chunk text
  const text = String(ocrText || '').trim();
  if (!text) {
    log.info('ingest: no OCR text, skipping chunk/embeddings');
    return;
  }
  // Build chunks, preserving page numbers when available
  const chunks = ocrPages && ocrPages.length > 0
    ? chunkTextByPages(ocrPages)
    : chunkText(text).map((c, i) => ({ content: c, page: null }));

  // 4) Embed and write chunks
  try {
    const embeddings = await embedChunks(chunks);
    // Remove prior chunks for this doc
    await app.supabaseAdmin.from('doc_chunks').delete().eq('org_id', orgId).eq('doc_id', docId);
    const rows = chunks.map((c, i) => ({ org_id: orgId, doc_id: docId, chunk_index: i, content: c.content, page: c.page ?? null, embedding: embeddings?.[i] || null }));
    // Insert in batches
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const slice = rows.slice(i, i + batchSize);
      const { error } = await app.supabaseAdmin.from('doc_chunks').upsert(slice, { onConflict: 'doc_id,chunk_index' });
      if (error) throw error;
    }
  } catch (e) {
    log.warn(e, 'ingest: embeddings or write failed');
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ingest.error', doc_id: docId, note: 'embeddings/write failed' }); } catch {}
  }

  log.info({ orgId, docId, chunks: chunks.length }, 'ingest complete');
}

function chunkText(text) {
  const target = 1200; // chars
  const overlap = 200;
  const words = text.split(/\s+/);
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const w of words) {
    const wlen = w.length + 1;
    if (len + wlen > target && buf.length > 0) {
      chunks.push(buf.join(' '));
      // overlap
      const back = [];
      let backLen = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        const l = buf[i].length + 1;
        if (backLen + l > overlap) break;
        back.unshift(buf[i]);
        backLen += l;
      }
      buf = back;
      len = back.join(' ').length;
    }
    buf.push(w);
    len += wlen;
  }
  if (buf.length) chunks.push(buf.join(' '));
  return chunks;
}

function chunkTextByPages(pages) {
  // pages: array of { page?: number, text: string }
  const out = [];
  let idx = 0;
  for (const p of pages) {
    const pageNum = typeof p.page === 'number' ? p.page : (idx + 1);
    const parts = chunkText(String(p.text || ''));
    for (const part of parts) out.push({ content: part, page: pageNum });
    idx++;
  }
  return out;
}

async function embedChunks(chunks) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  // OpenAI embeddings API expects an array of strings. Map chunk objects to their content.
  const inputs = Array.isArray(chunks)
    ? chunks.map((c) => (typeof c === 'string' ? c : (c && typeof c.content === 'string' ? c.content : '')))
    : [];
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: inputs }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI embed failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  const out = data?.data?.map((d) => d.embedding) || null;
  return out;
}

function normalizeDate(val) {
  const str = typeof val === 'string' ? val.trim() : '';
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  let m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const [_, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  m = str.match(/^(\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const [_, yy, mo, d] = m; const y = Number(yy) + 2000;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  const dt = new Date(str);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0,10);
  return null;
}
