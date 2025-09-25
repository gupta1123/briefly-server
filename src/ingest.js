import { generateMetadataEmbeddings } from './lib/metadata-embeddings.js';
import { uploadBufferToGemini, deleteGeminiFile, generateJsonFromGeminiFile } from './lib/gemini-files.js';

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

// Batch processing multiple documents in parallel
export async function ingestDocumentsBatch(app, documents) {
  const log = app.log || console;
  log.info({ count: documents.length }, 'Starting batch document ingestion');
  
  // Process documents in parallel (optimized for bulk uploads)
  const BATCH_SIZE = 10; // Process 10 documents at once (max frontend limit)
  const results = [];
  
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(doc => 
      ingestDocument(app, doc).catch(error => {
        log.error({ orgId: doc.orgId, docId: doc.docId, error: error.message }, 'Batch ingestion failed for document');
        return { error: error.message, docId: doc.docId };
      })
    );
    
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
    
    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < documents.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  const successful = results.filter(r => r.status === 'fulfilled' && !r.value?.error).length;
  const failed = results.length - successful;
  
  log.info({ total: documents.length, successful, failed }, 'Batch ingestion completed');
  return { successful, failed, results };
}

export async function ingestDocument(app, { orgId, docId, storageKey, mimeType, geminiFile }) {
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

  const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');

  let fileInfo = null;
  let effectiveMime = mimeType || 'application/octet-stream';

  try {
    if (geminiFile?.fileUri && geminiFile?.fileId) {
      fileInfo = {
        fileUri: geminiFile.fileUri,
        fileId: geminiFile.fileId,
        mimeType: geminiFile.mimeType || mimeType || 'application/octet-stream',
      };
      effectiveMime = fileInfo.mimeType;
      log.info({ orgId, docId, fileId: fileInfo.fileId }, 'ingest reusing Gemini file reference');
    } else {
      const { data: fileBlob, error: dlErr } = await app.supabaseAdmin.storage
        .from('documents')
        .download(storageKey);
      if (dlErr || !fileBlob) {
        log.error(dlErr, 'ingest: download failed');
        return;
      }
      const buffer = Buffer.from(await fileBlob.arrayBuffer());
      effectiveMime = mimeType || fileBlob.type || 'application/octet-stream';
      fileInfo = await uploadBufferToGemini(buffer, {
        mimeType: effectiveMime,
        displayName: baseName,
      });
      log.info({ orgId, docId, fileId: fileInfo.fileId }, 'ingest uploaded document to Gemini');
    }
  } catch (error) {
    log.warn(error, 'ingest: failed to prepare Gemini file');
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ingest.error', doc_id: docId, note: 'gemini upload failed' }); } catch {}
    return;
  }

  // Fetch per‑org summary prompt (fallback to default)
  let orgSummaryPrompt = 'Write a concise summary (<= 300 words) of the document text. Focus on essential facts and outcomes.';
  try {
    const { data: priv } = await app.supabaseAdmin
      .from('org_private_settings')
      .select('summary_prompt')
      .eq('org_id', orgId)
      .maybeSingle();
    if (priv?.summary_prompt && typeof priv.summary_prompt === 'string') {
      orgSummaryPrompt = priv.summary_prompt;
    }
  } catch {}
  try {
    if ((process.env.LOG_SUMMARY_PROMPT || '').toLowerCase() === 'true' || process.env.LOG_SUMMARY_PROMPT === '1') {
      const preview = String(orgSummaryPrompt).slice(0, 120).replace(/\n/g, ' ');
      app.log.info({ orgId, docId, promptPreview: preview }, 'Ingest: using org summary prompt');
    }
  } catch {}

  let ocrText = '';
  let ocrPages = [];
  let metadata = {};
  let summaryText = '';
  try {
    // Process all Gemini calls in parallel for 3x speed improvement
    const [ocr, meta, sum] = await Promise.all([
      generateJsonFromGeminiFile({
        fileUri: fileInfo.fileUri,
        mimeType: fileInfo.mimeType || effectiveMime,
        prompt: 'Extract readable text from the attached document. Prefer returning an array of pages when possible. Respond strictly as JSON in the form {"pages":[{"page":1,"text":"..."}],"extractedText":"..."}. If page-level text is not possible, supply extractedText only.',
      }),
      generateJsonFromGeminiFile({
        fileUri: fileInfo.fileUri,
        mimeType: fileInfo.mimeType || effectiveMime,
        prompt: `You are an expert document information extractor. Respond strictly as JSON with keys: title, subject, keywords (array, >=3), tags (array, 3-8), sender, receiver, senderOptions (array), receiverOptions (array), documentDate (ISO or empty), category (one of: ${availableCategories.join(', ')}). Do not include a summary in this response.`,
      }),
      generateJsonFromGeminiFile({
        fileUri: fileInfo.fileUri,
        mimeType: fileInfo.mimeType || effectiveMime,
        prompt: `${orgSummaryPrompt}\n\nRespond strictly as JSON with key "summary" containing the summary string.`,
      })
    ]);

    ocrPages = Array.isArray(ocr?.pages) ? ocr.pages.filter((p) => p && typeof p.text === 'string') : [];
    ocrText = typeof ocr?.extractedText === 'string' && ocr.extractedText.trim().length > 0
      ? ocr.extractedText
      : (Array.isArray(ocrPages) ? ocrPages.map((p) => String(p.text || '')).join('\n\n') : '');
    summaryText = (sum && typeof sum.summary === 'string') ? sum.summary : '';
    metadata = {
      title: (meta && typeof meta.title === 'string' && meta.title.trim()) ? meta.title : baseName,
      subject: (meta && typeof meta.subject === 'string' && meta.subject.trim()) ? meta.subject : baseName,
      keywords: Array.from(new Set((Array.isArray(meta?.keywords) ? meta.keywords : []).filter(Boolean).map((k) => String(k)).slice(0, 10).concat([baseName]))).slice(0, 10),
      tags: Array.from(new Set((Array.isArray(meta?.tags) ? meta.tags : []).filter(Boolean).map((k) => String(k)).slice(0, 8).concat(['document']))).slice(0, 8),
      summary: summaryText,
      sender: typeof meta?.sender === 'string' ? meta.sender : undefined,
      receiver: typeof meta?.receiver === 'string' ? meta.receiver : undefined,
      senderOptions: Array.isArray(meta?.senderOptions) ? meta.senderOptions : [],
      receiverOptions: Array.isArray(meta?.receiverOptions) ? meta.receiverOptions : [],
      documentDate: typeof meta?.documentDate === 'string' ? meta.documentDate : undefined,
      category: typeof meta?.category === 'string' ? meta.category : undefined,
    };
    try {
      if ((process.env.LOG_SUMMARY_PROMPT || '').toLowerCase() === 'true' || process.env.LOG_SUMMARY_PROMPT === '1') {
        app.log.info({ orgId, docId, summaryLen: (summaryText || '').length }, 'Ingest: summary generated');
      }
    } catch {}
  } catch (e) {
    log.warn(e, 'ingest: gemini extraction failed, continuing');
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ingest.error', doc_id: docId, note: String(e?.message || e) }); } catch {}
    if (fileInfo?.fileId) {
      log.warn({ orgId, docId, fileId: fileInfo.fileId }, 'ingest deleting Gemini file after extraction failure');
      await deleteGeminiFile(fileInfo.fileId).catch((err) => {
        log.warn({ orgId, docId, fileId: fileInfo.fileId, err: err?.message }, 'ingest failed to delete Gemini file after extraction failure');
      });
    }
    return;
  }

  if (fileInfo?.fileId) {
    log.info({ orgId, docId, fileId: fileInfo.fileId }, 'ingest deleting Gemini file after processing');
    await deleteGeminiFile(fileInfo.fileId).catch((err) => {
      log.warn({ orgId, docId, fileId: fileInfo.fileId, err: err?.message }, 'ingest failed to delete Gemini file');
    });
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

  // Generate metadata embeddings for the document
  try {
    // Get the updated document with all metadata
    const { data: document } = await app.supabaseAdmin
      .from('documents')
      .select('*')
      .eq('org_id', orgId)
      .eq('id', docId)
      .single();
      
    if (document) {
      await generateMetadataEmbeddings(app.supabaseAdmin, orgId, docId, document);
      log.info({ orgId, docId }, 'metadata embeddings generated');
    }
  } catch (e) {
    log.warn(e, 'ingest: metadata embeddings generation failed');
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ingest.error', doc_id: docId, note: 'metadata embeddings failed' }); } catch {}
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

function detectHeadings(pageText) {
  const lines = String(pageText||'').split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const heads = [];
  for (const line of lines) {
    if (line.length > 8 && line.length < 120) {
      const letters = line.replace(/[^A-Za-z]/g,'');
      const upper = letters.replace(/[^A-Z]/g,'').length;
      const ratio = letters.length ? upper/letters.length : 0;
      if (ratio > 0.6) heads.push(line);
    }
  }
  return heads;
}

function chunkTextByPages(pages) {
  // pages: array of { page?: number, text: string }
  const out = [];
  let idx = 0;
  for (const p of pages) {
    const pageNum = typeof p.page === 'number' ? p.page : (idx + 1);
    const raw = String(p.text || '');
    const heads = detectHeadings(raw);
    const parts = chunkText(raw);
    const prefix = heads.length ? `[Section: ${heads[0]}] ` : '';
    for (const part of parts) out.push({ content: prefix + part, page: pageNum });
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
