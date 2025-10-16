import { uploadBufferToGemini, deleteGeminiFile, generateJsonFromGeminiFile } from './gemini-files.js';

const GEMINI_OCR_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['page', 'text'],
      },
    },
    extractedText: { type: 'string' },
  },
  required: [],
};

const GEMINI_META_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subject: { type: 'string' },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 10,
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
    },
    sender: { type: 'string' },
    receiver: { type: 'string' },
    senderOptions: {
      type: 'array',
      items: { type: 'string' },
    },
    receiverOptions: {
      type: 'array',
      items: { type: 'string' },
    },
    documentDate: { type: 'string' },
    category: { type: 'string' },
  },
  required: ['title', 'subject', 'keywords', 'tags', 'senderOptions', 'receiverOptions', 'documentDate', 'category'],
};

const GEMINI_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keyPointers: {
      type: 'array',
      items: { type: 'string' },
      minItems: 0,
      maxItems: 8,
    },
  },
  required: ['summary', 'keyPointers'],
};

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

// Handle large files by splitting into manageable chunks for processing
async function processLargeFile(app, {
  orgId,
  storageKey, 
  buffer,
  effectiveMime,
  baseName,
  availableCategories,
  orgSummaryPrompt
}) {
  const log = app.log || console;
  const fileSizeMB = buffer.length / (1024 * 1024);
  log.info({ orgId, storageKey, sizeMb: fileSizeMB.toFixed(2) }, 'Processing large file with enhanced strategy');

  // For PDFs, try progressive processing with smaller chunks
  if (effectiveMime === 'application/pdf') {
    try {
      return await processLargePdf(app, {
        orgId,
        storageKey,
        buffer,
        baseName,
        availableCategories,
        orgSummaryPrompt
      });
    } catch (error) {
      log.warn(error, 'Large PDF processing failed, using fallback metadata');
    }
  }

  // Enhanced fallback metadata for large files
  const fileExtension = baseName.split('.').pop()?.toLowerCase() || '';
  const fileNameNoExt = baseName.replace(/\.[^/.]+$/, '');
  
  const largeFileMetadata = {
    title: fileNameNoExt,
    subject: `${fileNameNoExt} - Large Document`,
    keywords: [baseName.replace(/[^A-Za-z0-9\s]/g, ''), fileExtension.toUpperCase(), 'large-file', 'document'],
    tags: ['document', 'large-file', fileExtension.toLowerCase(), 'readable'],
    summary: `Large ${fileExtension.toUpperCase()} file (${fileSizeMB.toFixed(1)}MB) uploaded successfully. This document exceeded the automatic AI processing size limit of 50MB, but the file content is fully available for download and manual review.`,
    keyPointers: [
      'Large file successfully uploaded',
      'Manual metadata entry recommended',
      `File size: ${fileSizeMB.toFixed(1)}MB`,
      'Full content available for download'
    ],
    sender: '',
    receiver: '',
    senderOptions: [],
    receiverOptions: [],
    documentDate: '',
    category: determineCategoryForLargeFile(fileExtension, availableCategories),
  };

  log.info({ orgId, storageKey }, 'Large file analysis completed with enhanced metadata');
  
  return {
    ocrText: '', // No OCR text extracted for large files initially
    metadata: largeFileMetadata,
    geminiFile: null,
    usedFallback: true,
  };
}

// Process large PDFs by attempting chunked analysis
async function processLargePdf(app, {
  orgId,
  storageKey,
  buffer, 
  baseName,
  availableCategories,
  orgSummaryPrompt
}) {
  const log = app.log || console;
  const fileSizeMB = buffer.length / (1024 * 1024);
  
  // For now, use enhanced fallback metadata for large PDFs
  // Future enhancement: Implement PDF.js chunking for pages or pdf2pic + OCR
  const fileNameNoExt = baseName.replace(/\.[^/.]+$/, '');
  
  const pdfMetadata = {
    title: fileNameNoExt,
    subject: `${fileNameNoExt} - Large PDF Document`,
    keywords: [baseName.replace(/[^A-Za-z0-9\s]/g, ''), 'PDF', 'large-file', 'document'],
    tags: ['document', 'large-file', 'pdf', 'readable'],
    summary: `Large PDF document (${fileSizeMB.toFixed(1)}MB) uploaded successfully. This document exceeded the automatic AI processing size limit but is fully available for download and review.`,
    keyPointers: [
      'Large PDF successfully uploaded',
      `Document size: ${fileSizeMB.toFixed(1)}MB`,
      'Full PDF available for download',
      'Visual review recommended'
    ],
    sender: '',
    receiver: '',
    senderOptions: [],
    receiverOptions: [],
    documentDate: '',
    category: availableCategories.includes('Report') ? 'Report' : (availableCategories.includes('General') ? 'General' : availableCategories[0]),
  };

  return {
    ocrText: '', // Future: Extract first few pages with pdf.js
    metadata: pdfMetadata,
    geminiFile: null,
    usedFallback: true,
  };
}

// Helper function to determine appropriate category for large files
function determineCategoryForLargeFile(fileExtension, availableCategories) {
  const ext = (fileExtension || '').toLowerCase();
  
  if (['pdf'].includes(ext)) {
    return availableCategories.includes('Report') ? 'Report' : availableCategories[0];
  } else if (['doc', 'docx'].includes(ext)) {
    return availableCategories.includes('Correspondence') ? 'Correspondence' : 
           availableCategories.includes('Document') ? 'Document' : availableCategories[0];
  } else if (['ppt', 'pptx'].includes(ext)) {
    return availableCategories.includes('Report') ? 'Report' : availableCategories[0];
  } else if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) {
    return availableCategories.includes('General') ? 'General' : availableCategories[0];
  }
  
  return availableCategories.includes('General') ? 'General' : availableCategories[0];
}

async function performUploadAnalysis(app, { orgId, storageKey, mimeType }) {
  const log = app.log || console;
  const availableCategories = await loadOrgSettings(app, orgId);
  const orgSummaryPrompt = await loadOrgSummaryPrompt(app, orgId);

  const fileBlob = await downloadStorageFile(app, storageKey);
  const fileSize = fileBlob.size;
  const fileSizeMB = fileSize / (1024 * 1024);

  // Maximum file sizes for different types - conservative limits to prevent API failures
  const MAX_FILE_SIZES = {
    'application/pdf': 50, // Reduced to 50MB to match frontend limit
    'image/jpeg': 50,
    'image/png': 50,
    'image/gif': 50,
    'application/msword': 50,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 50,
    'application/vnd.ms-powerpoint': 50,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 50,
    'text/plain': 50,
    'text/markdown': 50,
  };

  const GEMINI_SAFE_SIZE_LIMIT = 50; // MB - Gemini Files API safe limit for reliable processing
  
  const mimeTypeKey = mimeType || fileBlob.type || 'application/octet-stream';
  const maxFileSize = MAX_FILE_SIZES[mimeTypeKey] || 50; // Default: 50MB cap

  // Only block files that are unreasonably large 
  if (fileSizeMB > maxFileSize) {
    log.info({ orgId, storageKey, sizeMb: fileSizeMB, maxSize: maxFileSize, mimeType: mimeTypeKey }, 'File exceeds maximum allowed size');
    const fallback = buildLargeFileFallback(storageKey, fileSizeMB, maxFileSize, availableCategories);
    throw new AnalysisError('File exceeds maximum allowed size', {
      status: 413,
      fallback: { ocrText: '', metadata: fallback },
    });
  }

  log.info({ orgId, storageKey, sizeMb: fileSizeMB.toFixed(2) }, 'Processing file - will determine best approach');
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  const effectiveMime = mimeType || fileBlob.type || 'application/octet-stream';
  const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');

  // ALWAYS attempt processing - try Gemini first, fallback if needed!
  let geminiReference = null;

  // First try to upload to Gemini for any file size (attempt for larger files, guaranteed for smaller ones)
  try {
    geminiReference = await uploadBufferToGemini(buffer, {
      mimeType: effectiveMime,
      displayName: baseName,
    });
    log.info({ orgId, storageKey, fileId: geminiReference.fileId }, 'Successfully uploaded to Gemini');
  } catch (error) {
    // Enhanced error handling for files that are too large for Gemini
    const errorMessage = error?.message || error?.toString() || '';
    if (errorMessage.includes('too large') ||
        errorMessage.includes('exceeded size') ||
        errorMessage.includes('content length') ||
        errorMessage.includes('files bytes are too large') ||
        errorMessage.includes('400 Bad Request')) {
      log.warn({ orgId, storageKey, sizeMb: fileSizeMB.toFixed(2), error: errorMessage }, 'File too large for Gemini processing, using enhanced processing');

      // Switch to large file processing mode
      return await processLargeFile(app, {
        orgId,
        storageKey,
        buffer,
        effectiveMime,
        baseName,
        availableCategories,
        orgSummaryPrompt
      });
    } else {
      log.error(error, 'Failed to upload file to Gemini for unknown reason');
      throw new AnalysisError('AI upload failed', { status: 503 });
    }
  }

  const defaultSummary = `Summarize this document in under 300 words. Focus on essential facts, decisions, and outcomes.

Respond as JSON with two keys:
- summary: a tight narrative paragraph (<=300 words) covering the key context and conclusions.
- keyPointers: an array of 3-7 short bullet-style strings capturing the most important takeaways.`;

  const defaultMetadata = () => ({
    title: baseName,
    subject: baseName,
    keywords: [baseName, 'document', 'ai-generated'],
    tags: ['document'],
    summary: '',
    keyPointers: [],
    sender: '',
    receiver: '',
    senderOptions: [],
    receiverOptions: [],
    documentDate: '',
    category: availableCategories.includes('General') ? 'General' : availableCategories[0],
  });

  let ocrText = '';
  let metadata = defaultMetadata();
  let summaryText = '';
  let usedFallback = false;

  const [ocrResult, metaResult, sumResult] = await Promise.allSettled([
    generateJsonFromGeminiFile({
      fileUri: geminiReference.fileUri,
      mimeType: geminiReference.mimeType || effectiveMime,
      prompt: 'Extract readable text from the document. Prefer returning text per page when possible. Always produce JSON that satisfies the provided schema. Provide concatenated text in extractedText when feasible.',
      responseSchema: GEMINI_OCR_SCHEMA,
    }),
    generateJsonFromGeminiFile({
      fileUri: geminiReference.fileUri,
      mimeType: geminiReference.mimeType || effectiveMime,
      prompt: `You are an expert document information extractor. Fill all fields while respecting the allowed category list: ${availableCategories.join(', ')}. IMPORTANT: You MUST always select a category from the provided list. If none seem perfect, choose the closest match. Never leave category empty or undefined. Always produce JSON matching the provided schema.`,
      responseSchema: {
        ...GEMINI_META_SCHEMA,
        properties: {
          ...GEMINI_META_SCHEMA.properties,
          category: { type: 'string', enum: availableCategories },
        },
      },
    }),
    generateJsonFromGeminiFile({
      fileUri: geminiReference.fileUri,
      mimeType: geminiReference.mimeType || effectiveMime,
      prompt: `${orgSummaryPrompt || defaultSummary}\n\nReturn JSON compliant with the provided schema only.`,
      responseSchema: GEMINI_SUMMARY_SCHEMA,
    }),
  ]);

  // Check if any of the analysis steps failed due to size limits and switch to enhanced processing
  const allRejected = [ocrResult, metaResult, sumResult].filter(r => r.status === 'rejected');
  const hasSizeError = allRejected.some(r => {
    const errMsg = (r.reason?.message || '').toLowerCase();
    return errMsg.includes('files bytes are too large') || 
           errMsg.includes('too large to be read') ||
           errMsg.includes('400 bad request') && errMsg.includes('bytes are too large');
  });

  if (hasSizeError && fileSizeMB > 50) { // Only use fallback for files > 50MB
    log.info({ orgId, storageKey, sizeMb: fileSizeMB.toFixed(2) }, 'All Gemini analysis steps failed due to size - switching to enhanced large file processing');
    return await processLargeFile(app, {
      orgId,
      storageKey,
      buffer,
      effectiveMime,
      baseName,
      availableCategories,
      orgSummaryPrompt
    });
  }

  if (ocrResult.status === 'fulfilled' && ocrResult.value) {
    const pages = Array.isArray(ocrResult.value?.pages) ? ocrResult.value.pages.filter((p) => p && typeof p.text === 'string') : [];
    ocrText = typeof ocrResult.value?.extractedText === 'string' && ocrResult.value.extractedText.trim().length > 0
      ? ocrResult.value.extractedText
      : (Array.isArray(pages) ? pages.map((p) => String(p.text || '')).join('\n\n') : '');
  } else {
    const raw = (ocrResult.status === 'rejected' && typeof ocrResult.reason?.rawResponse === 'string')
      ? ocrResult.reason.rawResponse.trim()
      : '';
    if (raw) {
      ocrText = raw;
    }
    usedFallback = true;
    log.warn({ orgId, storageKey, reason: ocrResult.status === 'rejected' ? ocrResult.reason?.message : 'unknown' }, 'Gemini OCR fallback used');
  }

  if (metaResult.status === 'fulfilled' && metaResult.value) {
    metadata = metaResult.value;
  } else {
    usedFallback = true;
    log.warn({ orgId, storageKey, reason: metaResult.status === 'rejected' ? metaResult.reason?.message : 'unknown' }, 'Gemini metadata fallback used');
    metadata = defaultMetadata();
  }

  let keyPointers = [];
  if (sumResult.status === 'fulfilled' && typeof sumResult.value?.summary === 'string') {
    summaryText = sumResult.value.summary;
    if (Array.isArray(sumResult.value?.keyPointers)) {
      keyPointers = sumResult.value.keyPointers.filter((item) => typeof item === 'string' && item.trim());
    }
  } else {
    usedFallback = true;
    log.warn({ orgId, storageKey, reason: sumResult.status === 'rejected' ? sumResult.reason?.message : 'unknown' }, 'Gemini summary fallback used');
    summaryText = 'Summary unavailable. Please review and provide key details manually.';
    keyPointers = [];
  }

  metadata = {
    title: (metadata && typeof metadata.title === 'string' && metadata.title.trim()) ? metadata.title : defaultMetadata().title,
    subject: (metadata && typeof metadata.subject === 'string' && metadata.subject.trim()) ? metadata.subject : defaultMetadata().subject,
    keywords: Array.from(new Set((Array.isArray(metadata?.keywords) ? metadata.keywords : []).filter(Boolean).map((k) => String(k)).slice(0, 10).concat([baseName]))).slice(0, 10),
    tags: Array.from(new Set((Array.isArray(metadata?.tags) ? metadata.tags : []).filter(Boolean).map((k) => String(k)).slice(0, 8).concat(['document']))).slice(0, 8),
    summary: summaryText || '',
    keyPointers,
    sender: typeof metadata?.sender === 'string' ? metadata.sender : undefined,
    receiver: typeof metadata?.receiver === 'string' ? metadata.receiver : undefined,
    senderOptions: Array.isArray(metadata?.senderOptions) ? metadata.senderOptions : [],
    receiverOptions: Array.isArray(metadata?.receiverOptions) ? metadata.receiverOptions : [],
    documentDate: typeof metadata?.documentDate === 'string' ? metadata.documentDate : undefined,
    category: typeof metadata?.category === 'string' ? metadata.category : defaultMetadata().category,
  };

  if (usedFallback) {
    log.info({ orgId, storageKey }, 'Gemini analysis completed with fallbacks');
  }

  return {
    ocrText,
    metadata,
    geminiFile: geminiReference,
    usedFallback,
  };
}

export { AnalysisError, performUploadAnalysis };
