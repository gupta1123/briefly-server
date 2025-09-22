import { generateText } from '../lib/ai-service.js';

// Structured QA for tables and sums in a single document context.
// Given a merged text context, extract tabular rows or line items and answer precisely.

export async function structuredQA({ question, contextText }) {
  const prompt = `You will answer a precise question based ONLY on the provided document excerpts. If needed, extract structured data first.

Special Instructions for Numerical Queries:
- For questions about values, amounts, totals, or currency (₹, Rs.), look for EXACT numerical matches
- Extract specific numbers with their context, not just semantic similarity
- When you find currency values, include the exact amount in your answer
- For "total value" questions, look for lines with "total", "amount", "value", "worth"

Task types:
- TableExtract: detect tables (e.g., month-wise data with units and amounts) and output a Markdown table with clear headers.
- VerifySum: detect a list of charges/credits with amounts, compute the sum, and compare with a stated total. Output a short Markdown explanation and a compact Markdown table of components. Include discrepancy if any.

Output format (strict):
- Use GitHub-Flavored Markdown only. Prefer concise bullet points, and use Markdown tables when listing rows.
- Do NOT invent values. If a field is missing in the excerpts, write "(not visible)".
- Do NOT include any JSON or code blocks in your answer. Only Markdown prose and tables.
- If you find specific numerical values, state them clearly in the format "The [what] was [value]"

Question:
${question}

Excerpts:
${contextText}`;
  const res = await generateText({ prompt, temperature: 0.2 });
  return { answer: String(res?.text || '').trim() };
}

export default { structuredQA };