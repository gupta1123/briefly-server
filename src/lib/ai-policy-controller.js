import { definePrompt, safeLLMCall } from './ai-service.js';
import { z } from 'zod';

// Strong, explicit policy controller for routing within a scope (doc/folder/org)
// Returns a structured decision with optional clarification.

const PolicyInput = z.object({
  scope: z.enum(['doc','folder','org']).default('doc'),
  docId: z.string().nullable().optional(),
  includeLinked: z.boolean().optional().default(false),
  includeVersions: z.boolean().optional().default(false),
  question: z.string(),
  memory: z
    .object({
      focusDocIds: z.array(z.string()).optional(),
      lastCitedDocIds: z.array(z.string()).optional(),
      filters: z
        .object({ dateRange: z.string().optional(), docType: z.string().optional(), sender: z.string().optional(), receiver: z.string().optional() })
        .optional(),
    })
    .optional(),
  docMeta: z.object({ title: z.string().optional(), filename: z.string().optional(), type: z.string().optional(), category: z.string().optional() }).optional(),
});

const PolicyOutput = z.object({
  task: z.enum(['SummarizeDoc','QAAboutDoc','MetadataQA','LinkedContext','ListDocs','FolderQA']),
  confidence: z.number().min(0).max(1),
  requires_clarification: z.boolean().optional().default(false),
  clarify: z.string().nullable().optional(),
  suggested_filters: z
    .object({ dateRange: z.string().optional(), docType: z.string().optional(), sender: z.string().optional(), receiver: z.string().optional() })
    .nullable()
    .optional(),
});

const policyPrompt = definePrompt({
  name: 'AIPolicyRouter',
  input: { schema: PolicyInput },
  output: { schema: PolicyOutput },
  prompt: `You are a routing controller for a document assistant. Classify the best task for the user's question given the scope and context.

Tasks (choose exactly one):
- SummarizeDoc: brief overview of the current document.
- QAAboutDoc: answer a specific question about the current document using only its content.
- MetadataQA: return document properties (title, subject, sender, receiver, date, category, type, filename).
- LinkedContext: answer using the current document plus its versions and linked documents.
  (Folder scope tasks)
- ListDocs: list top documents in the current folder scope with basic attributes.
- FolderQA: answer across multiple documents in the folder scope (shortlist 2–3 docs, use snippets, synthesize).

Routing rules:
- HARD RULES (must-follow):
  - If the question includes or implies any of: sender, receiver, from:, to:, "who sent", "who is the sender", "who is the receiver", "to whom", recipient, addressee, file name, document type → ALWAYS choose MetadataQA in doc scope.
  - If includeLinked=true or includeVersions=true or the question explicitly mentions linked/related/versions → choose LinkedContext in doc scope.

- General rules:
  - Scope=doc: never "find". Choose among the four tasks above only.
  - Prefer MetadataQA when the question clearly asks for properties (title/subject/sender/receiver/date/category/type/filename or synonyms like: file name, doc type, "who sent", "who is the sender", "who is the receiver", "to whom", recipient, addressee).
  - Prefer LinkedContext if the question mentions linked/related/versions, or includeLinked/includeVersions is true, or the question clearly needs context beyond this doc.
  - Prefer SummarizeDoc if the question is vague (e.g., "what is this about", "overview", "summary") or not a specific factual query.
  - Otherwise, choose QAAboutDoc.

- Folder scope guidance:
  - If the question looks like a list/find/show request, choose ListDocs.
  - If the question asks for analysis/answer across documents (not just a listing), choose FolderQA.
  - If the question asks about metadata fields but is ambiguous across many docs, set requires_clarification=true and propose filters.

Clarification:
- If the question is ambiguous or likely needs constraints (date range, doc type, sender/receiver), set requires_clarification=true, and provide a short clarify question and suggested_filters.
- Keep answers minimal and only return JSON.

Return strictly valid JSON conforming to the output schema.

Examples (doc scope):
- Q: "Who sent this document?" → { "task": "MetadataQA" }
- Q: "To whom was it addressed?" → { "task": "MetadataQA" }
- Q: "What is the document type?" → { "task": "MetadataQA" }
- Q: "Show linked versions" → { "task": "LinkedContext" }
- Q: "What is this about?" → { "task": "SummarizeDoc" }
- Q: "Does it mention penalties?" → { "task": "QAAboutDoc" }

Examples (folder scope):
- Q: "Find me docs related to LLM" → { "task": "ListDocs" }
- Q: "What happened across these cases?" → { "task": "FolderQA" }
- Q: "Who is the sender?" (no specific doc) → { "task": "FolderQA", "requires_clarification": true, "clarify": "Which document or which date range/type should I focus on?", "suggested_filters": { "dateRange": "YYYY-MM to YYYY-MM", "docType": "...", "sender": "..." } }

Input:
scope: {{scope}}
docId: {{docId}}
includeLinked: {{includeLinked}}
includeVersions: {{includeVersions}}
question: {{question}}
memory: {{memory}}
docMeta: {{docMeta}}
`
});

export async function decideTaskAI(ctx, question, extras = {}) {
  const input = {
    scope: (ctx?.scope || 'doc'),
    docId: ctx?.docId || null,
    includeLinked: !!ctx?.includeLinked,
    includeVersions: !!ctx?.includeVersions,
    question: String(question || '').slice(0, 2000),
    memory: extras?.memory || {},
    docMeta: extras?.docMeta || {},
  };
  const res = await safeLLMCall(() => policyPrompt(input), { maxRetries: 2 });
  // Basic sanity fallback
  if (!res || !res.task) return { task: 'QAAboutDoc', confidence: 0.6, requires_clarification: false };
  return res;
}

export default { decideTaskAI };
