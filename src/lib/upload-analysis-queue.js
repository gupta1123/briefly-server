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
      // Process jobs in parallel batches for better performance
      const BATCH_SIZE = 10; // Process 10 jobs simultaneously (optimized for bulk uploads)
      
      while (queue.length > 0) {
        const batch = [];
        // Take up to BATCH_SIZE jobs from the queue
        for (let i = 0; i < BATCH_SIZE && queue.length > 0; i++) {
          const job = queue.shift();
          if (job) {
            job.status = 'processing';
            job.updatedAt = Date.now();
            batch.push(job);
          }
        }
        
        if (batch.length === 0) break;
        
        // Process all jobs in the batch in parallel
        const promises = batch.map(async (job) => {
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
        });
        
        // Wait for all jobs in the batch to complete
        await Promise.allSettled(promises);
        
        // Small delay between batches to prevent overwhelming the system
        if (queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
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
