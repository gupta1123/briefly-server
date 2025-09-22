import { randomUUID } from 'crypto';
import { performUploadAnalysis, AnalysisError } from './upload-analysis.js';

const jobs = new Map();
const queue = [];
let processing = false;
let appRef = null;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const JOB_TTL_MS = 10 * 60 * 1000;
let cleanupTimer = null;

function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
      if (now - job.createdAt > JOB_TTL_MS) {
        jobs.delete(jobId);
      }
    }
    if (jobs.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function ensureApp() {
  if (!appRef) throw new Error('Upload analysis queue not initialized');
}

function scheduleProcessing() {
  if (processing) return;
  processing = true;
  setImmediate(async () => {
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) break;
        job.status = 'processing';
        job.updatedAt = Date.now();
        try {
          const data = await performUploadAnalysis(appRef, job.payload);
          job.status = 'succeeded';
          job.result = { data };
        } catch (error) {
          if (error instanceof AnalysisError) {
            job.status = 'failed';
            job.result = {
              error: error.message,
              httpStatus: error.status,
              fallback: error.fallback,
            };
          } else {
            job.status = 'failed';
            job.result = {
              error: error?.message || String(error),
              httpStatus: 500,
            };
            appRef?.log?.error?.(error, 'Upload analysis job failed unexpectedly');
          }
        }
        job.updatedAt = Date.now();
      }
    } finally {
      processing = false;
    }
  });
}

function initUploadAnalysisQueue(app) {
  if (appRef) return; // already initialized
  appRef = app;
  scheduleCleanup();
}

function enqueueUploadAnalysisJob(payload) {
  ensureApp();
  const id = randomUUID();
  const job = {
    id,
    status: 'queued',
    payload,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
  };
  jobs.set(id, job);
  queue.push(job);
  scheduleProcessing();
  scheduleCleanup();
  return {
    jobId: id,
    status: job.status,
    expiresAt: job.createdAt + JOB_TTL_MS,
  };
}

function getUploadAnalysisJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    orgId: job.payload?.orgId,
  };
}

export { initUploadAnalysisQueue, enqueueUploadAnalysisJob, getUploadAnalysisJob };
