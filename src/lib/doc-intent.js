import { definePrompt, safeLLMCall } from './ai-service.js';
import { z } from 'zod';

const Input = z.object({ question: z.string() });
const Output = z.object({
  mode: z.enum(['PlainQA','TableExtract','VerifySum']),
  confidence: z.number().min(0).max(1)
});

const intentPrompt = definePrompt({
  name: 'DocIntentClassifier',
  input: { schema: Input },
  output: { schema: Output },
  prompt: `Classify a user question about a single document into one of:
- PlainQA: direct question answered by quoting or summarizing text.
- TableExtract: build a table from bill-like sections (e.g., BILL MONTH with units/amounts; month-wise values).
- VerifySum: verify or compute totals by summing line items (e.g., charges, credits) and compare to a stated total.

HARD RULES (must-follow):
- If the question asks to verify a total by summing charges/credits, or includes phrases like "verify", "sum", "add up", "difference", "discrepancy", or mentions a named total like "TOTAL CURRENT BILL", choose VerifySum.
- If the question asks for a month-wise or columnar table (e.g., BILL MONTH, months with units/amounts), choose TableExtract.

Choose TableExtract when the question asks to produce a table with months/units/amounts or similar tabular fields.
Choose VerifySum when the user asks to verify a total by summing listed charges/credits.
Otherwise choose PlainQA.
Respond with JSON only.

Question: {{question}}
`
});

export async function classifyDocIntent(question) {
  const res = await safeLLMCall(() => intentPrompt({ question: String(question || '').slice(0, 1000) }), { maxRetries: 2 });
  if (!res || !res.mode) return { mode: 'PlainQA', confidence: 0.5 };
  return res;
}

export default { classifyDocIntent };
