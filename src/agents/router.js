import { ai } from '../ai.js';
import { z } from 'zod';

// Define router output schema (smarter, context-aware)
const RouterOutput = z.object({
  intent: z.enum([
    'FindFiles',
    'Metadata',
    'ContentQA',
    'Linked',
    'Diff',
    'Analytics',
    'Timeline',
    'Extract',
  ]),
  filters: z
    .object({
      docType: z.string().optional(),
      sender: z.string().optional(),
      receiver: z.string().optional(),
      date: z.string().optional(),
      month: z.string().optional(),
      entity: z.string().optional(),
      fields: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
    })
    .default({}),
  answerType: z.enum(['content','metadata','mixed']).optional().default('content'),
  requiredFields: z.array(z.string()).optional().default([]),
  primaryAgent: z.enum(['finder','metadata','content','linked','diff','analytics','timeline','extract']).optional(),
  secondaryEmitters: z.array(z.enum(['finder','metadata','content','linked','diff','analytics','timeline','extract'])).optional().default([]),
  target: z
    .object({
      prefer: z.enum(['focus', 'list', 'none']).default('none'),
      ordinal: z.number().int().min(1).optional(),
      wantPreview: z.boolean().optional().default(false),
    })
    .default({ prefer: 'none' }),
  needsClarification: z.boolean().optional().default(false),
  confidence: z.number().optional().default(0.6),
});

const RouterInput = z.object({
  question: z.string(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']).optional(),
        content: z.string().optional(),
      })
    )
    .optional(),
  memory: z
    .object({
      focusDocIds: z.array(z.string()).optional(),
      lastCitedDocIds: z.array(z.string()).optional(),
      lastListDocIds: z.array(z.string()).optional(),
      filters: z
        .object({ sender: z.string().optional(), receiver: z.string().optional(), docType: z.string().optional() })
        .optional(),
    })
    .optional(),
});

const routerPrompt = ai.definePrompt({
  name: 'ChatRouter',
  input: { schema: RouterInput },
  output: { schema: RouterOutput },
  prompt: `You are a context-aware router for a document assistant.
Return ONLY JSON per the output schema.

Decide the user's intent and extract filters. Also determine target preference:
- prefer = 'focus' when the user likely refers to the last document(s) discussed (pronouns like it/this/that, or follow-ups that ask for fields or content).
- prefer = 'list' when the user likely refers to items previously listed (ordinals like first/second/third, "the 2nd one"). If you detect an ordinal, set target.ordinal accordingly.
- prefer = 'none' otherwise.
Set wantPreview = true when the user asks to preview/show/open the doc.

Intents:
- FindFiles: list/search documents (bills, notices, invoices, etc.) possibly filtered by sender/receiver/date/type/keywords.
- Metadata: asks for subject/sender/receiver/date/filename/tags/summary for a specific document.
- ContentQA: asks for content details of a doc requiring reading text (e.g., amounts, explanations, clauses).
- Linked: wants versions/links/relationships.
- Diff: wants differences between versions or two docs.
- Analytics: wants counts/top aggregations.
- Timeline: wants a chronological view for an entity.
- Extract: wants structured field extraction across many docs.

Consider history and memory (focusDocIds, lastCitedDocIds, lastListDocIds) to resolve pronouns and ordinals, but DO NOT output IDs—only target preference and ordinal.
Extract filters if present; be precise and minimal.
If ambiguous, set needsClarification = true with lower confidence.

Also decide:
- answerType ('content' vs 'metadata' vs 'mixed') based on whether the user asks for content reading (amount/date/clauses) or metadata fields.
- requiredFields: name the specific fields requested (e.g., ["amount","billingPeriod","month","year","sender","receiver"]).
- primaryAgent: one of finder|metadata|content|linked|diff|analytics|timeline|extract — the main agent to run this turn.
- secondaryEmitters: zero or more agents that may emit UI blocks without ending the turn (e.g., ['metadata'] when primary is 'content').

Examples (conceptual, not to be echoed):
1) "list my electricity docs" → intent=FindFiles, filters.docType="bill" or "electricity bill", primaryAgent="finder".
2) "any linked docs" (after a list/focus) → intent=Linked, target.prefer='focus' or 'list', primaryAgent='linked'.
3) "summary" (after focusing a doc) → intent=Metadata, answerType='metadata', requiredFields=['summary'], primaryAgent='metadata'.
4) "how much is the bill and what month is it from" → intent=ContentQA, answerType='content', requiredFields=['amount','billingPeriod','month','year'], primaryAgent='content', target.prefer='focus'.
`,
});

export async function routeQuestion({ question, history = [], memory = {} }) {
  try {
    const { output } = await routerPrompt({ question, history, memory });
    return output;
  } catch (e) {
    // Fallback to a reasonable default intent
    return { intent: 'ContentQA', filters: {}, needsClarification: false, confidence: 0.5 };
  }
}
