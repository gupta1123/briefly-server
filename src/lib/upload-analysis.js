import { uploadBufferToGemini, deleteGeminiFile, generateJsonFromGeminiFile } from './gemini-files.js';

class AnalysisError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AnalysisError';
    this.status = options.status || 500;
    this.fallback = options.fallback;
  }
}

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

async function loadOrgSettings(app, orgId) {
  const defaults = ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'];
  try {
    const { data, error } = await app.supabaseAdmin
      .from('org_settings')
      .select('categories')
      .eq('org_id', orgId)
      .maybeSingle();
    if (error) throw error;
    if (Array.isArray(data?.categories) && data.categories.length > 0) {
      return data.categories;
    }
  } catch (err) {
    app.log?.warn?.(err, 'Failed to load org categories');
  }
  return defaults;
}

async function loadOrgSummaryPrompt(app, orgId) {
  let prompt = 'Write a concise summary (<= 300 words) of the document text. Focus on essential facts and outcomes.';
  try {
    const { data, error } = await app.supabaseAdmin
      .from('org_private_settings')
      .select('summary_prompt')
      .eq('org_id', orgId)
      .maybeSingle();
    if (!error && data?.summary_prompt && typeof data.summary_prompt === 'string') {
      prompt = data.summary_prompt;
    }
  } catch (err) {
    app.log?.warn?.(err, 'Failed to load org summary prompt');
  }
  return prompt;
}

async function downloadStorageFile(app, storageKey) {
  const { data, error } = await app.supabaseAdmin.storage.from('documents').download(storageKey);
  if (error || !data) {
    throw new AnalysisError('Unable to download storage object', { status: 400 });
  }
  return data;
}

function buildLargeFileFallback(storageKey, sizeMb, sizeLimitMb, availableCategories) {
  const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');
  const fileExtension = baseName.split('.').pop()?.toLowerCase() || '';
  const summary = `Large ${fileExtension.toUpperCase() || 'document'} file (${sizeMb.toFixed(1)}MB) - AI processing skipped due to size limits. Please review and add metadata manually if needed.`;
  const description = `This is a large file that exceeded the AI processing limit of ${sizeLimitMb}MB. The document has been uploaded successfully but AI analysis was skipped to prevent processing timeouts.`;

  const fallback = {
    title: baseName.replace(/\.[^/.]+$/, ''),
    subject: `${baseName} - Large Document`,
    keywords: [baseName, fileExtension.toUpperCase(), 'large-file', 'document'],
    tags: ['document', 'large-file', fileExtension || 'unknown'],
    summary,
    description,
    category: availableCategories.includes('General') ? 'General' : availableCategories[0],
  };

  if (['pdf'].includes(fileExtension)) {
    fallback.tags.push('pdf', 'readable');
    fallback.category = availableCategories.includes('Report') ? 'Report' : fallback.category;
  } else if (['doc', 'docx'].includes(fileExtension)) {
    fallback.tags.push('word', 'editable');
    fallback.category = availableCategories.includes('Correspondence') ? 'Correspondence' : fallback.category;
  } else if (['ppt', 'pptx'].includes(fileExtension)) {
    fallback.tags.push('presentation', 'slides');
    fallback.category = availableCategories.includes('Report') ? 'Report' : fallback.category;
  } else if (['jpg', 'jpeg', 'png', 'gif'].includes(fileExtension)) {
    fallback.tags.push('image', 'visual');
    fallback.category = availableCategories.includes('General') ? 'General' : fallback.category;
  }

  return fallback;
}

async function performUploadAnalysis(app, { orgId, storageKey, mimeType }) {
  const log = app.log || console;
  const availableCategories = await loadOrgSettings(app, orgId);
  const orgSummaryPrompt = await loadOrgSummaryPrompt(app, orgId);

  const fileBlob = await downloadStorageFile(app, storageKey);
  const fileSize = fileBlob.size;
  const fileSizeMB = fileSize / (1024 * 1024);

  const AI_SIZE_LIMITS = {
    'application/pdf': 100,
    'image/jpeg': 50,
    'image/png': 50,
    'image/gif': 20,
    'application/msword': 50,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 50,
    'application/vnd.ms-powerpoint': 75,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 75,
    'text/plain': 10,
    'text/markdown': 10,
  };

  const mimeTypeKey = mimeType || fileBlob.type || 'application/octet-stream';
  const sizeLimit = AI_SIZE_LIMITS[mimeTypeKey] || 50;

  if (fileSizeMB > sizeLimit) {
    log.info({ orgId, storageKey, sizeMb: fileSizeMB, sizeLimit, mimeType: mimeTypeKey }, 'Upload skipped AI processing due to size');
    const fallback = buildLargeFileFallback(storageKey, fileSizeMB, sizeLimit, availableCategories);
    throw new AnalysisError('File too large for AI processing', {
      status: 413,
      fallback: { ocrText: '', metadata: fallback },
    });
  }

  log.info({ orgId, storageKey, sizeMb: fileSizeMB.toFixed(2) }, 'Processing file with Gemini Files API');
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  const effectiveMime = mimeType || fileBlob.type || 'application/octet-stream';
  const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');

  let geminiReference = null;
  try {
    geminiReference = await uploadBufferToGemini(buffer, {
      mimeType: effectiveMime,
      displayName: baseName,
    });
    log.info({ orgId, storageKey, fileId: geminiReference.fileId }, 'Uploaded file to Gemini');
  } catch (error) {
    log.error(error, 'Failed to upload file to Gemini');
    throw new AnalysisError('AI upload failed', { status: 503 });
  }

  try {
    const ocr = await generateJsonFromGeminiFile({
      fileUri: geminiReference.fileUri,
      mimeType: geminiReference.mimeType || effectiveMime,
      prompt: 'Extract readable text from the attached document. Prefer returning an array of pages when possible. Respond strictly as JSON in the form {"pages":[{"page":1,"text":"..."}],"extractedText":"..."}. If page-level text is not possible, supply extractedText only.',
    });

    const meta = await generateJsonFromGeminiFile({
      fileUri: geminiReference.fileUri,
      mimeType: geminiReference.mimeType || effectiveMime,
      prompt: `You are an expert document information extractor. Respond strictly as JSON with keys: title, subject, keywords (array, >=3), tags (array, 3-8), sender, receiver, senderOptions (array), receiverOptions (array), documentDate (ISO or empty), category (one of: ${availableCategories.join(', ')}). Do not include a summary in this response.`,
    });

    const sum = await generateJsonFromGeminiFile({
      fileUri: geminiReference.fileUri,
      mimeType: geminiReference.mimeType || effectiveMime,
      prompt: `${orgSummaryPrompt}\n\nRespond strictly as JSON with key "summary" containing the summary string.`,
    });

    const ocrPages = Array.isArray(ocr?.pages) ? ocr.pages.filter((p) => p && typeof p.text === 'string') : [];
    const extractedText = typeof ocr?.extractedText === 'string' && ocr.extractedText.trim().length > 0
      ? ocr.extractedText
      : (Array.isArray(ocrPages) ? ocrPages.map((p) => String(p.text || '')).join('\n\n') : '');

    const ensured = {
      title: (meta && typeof meta.title === 'string' && meta.title.trim()) ? meta.title : baseName,
      subject: (meta && typeof meta.subject === 'string' && meta.subject.trim()) ? meta.subject : baseName,
      keywords: Array.from(new Set((Array.isArray(meta?.keywords) ? meta.keywords : []).filter(Boolean).map((k) => String(k)).slice(0, 10).concat([baseName]))).slice(0, 10),
      tags: Array.from(new Set((Array.isArray(meta?.tags) ? meta.tags : []).filter(Boolean).map((k) => String(k)).slice(0, 8).concat(['document']))).slice(0, 8),
      summary: (sum && typeof sum.summary === 'string') ? sum.summary : '',
      sender: typeof meta?.sender === 'string' ? meta.sender : undefined,
      receiver: typeof meta?.receiver === 'string' ? meta.receiver : undefined,
      senderOptions: Array.isArray(meta?.senderOptions) ? meta.senderOptions : [],
      receiverOptions: Array.isArray(meta?.receiverOptions) ? meta.receiverOptions : [],
      documentDate: typeof meta?.documentDate === 'string' ? meta.documentDate : undefined,
      category: typeof meta?.category === 'string' ? meta.category : undefined,
    };

    return {
      ocrText: extractedText,
      metadata: ensured,
      geminiFile: geminiReference,
    };
  } catch (error) {
    log.error(error, 'Gemini analysis failed');
    if (geminiReference?.fileId) {
      log.warn({ orgId, storageKey, fileId: geminiReference.fileId }, 'Deleting Gemini file after failure');
      await deleteGeminiFile(geminiReference.fileId).catch((err) => {
        log.warn({ orgId, storageKey, fileId: geminiReference.fileId, err: err?.message }, 'Failed to delete Gemini file after failure');
      });
    }

    const fallbackMeta = {
      title: baseName,
      subject: baseName,
      keywords: [baseName],
      tags: ['document'],
      summary: 'AI analysis failed. Metadata was generated from the filename—please review and update manually.',
      sender: '',
      receiver: '',
      senderOptions: [],
      receiverOptions: [],
      documentDate: '',
      category: availableCategories.includes('General') ? 'General' : availableCategories[0],
    };

    throw new AnalysisError('AI analysis failed', {
      status: 503,
      fallback: { ocrText: '', metadata: fallbackMeta },
    });
  }
}

export { AnalysisError, performUploadAnalysis };
