import { definePrompt, safeLLMCall } from './ai-service.js';
import { z } from 'zod';

const Input = z.object({ question: z.string(), answer: z.string() });
const Output = z.object({ answer: z.string() });

const finalizer = definePrompt({
  name: 'AnswerFinalizer',
  input: { schema: Input },
  output: { schema: Output },
  prompt: `You rewrite the draft answer so it best matches the user's question.

Rules:
- Use GitHub-Flavored Markdown (GFM) only.
- If the question asks for a table or month-wise values, include a Markdown table with clear headers.
- Keep content grounded in the original answer; do not add new claims or numbers.
- Make the answer concise and scannable (headings, bullets, tables).
- Do NOT include any JSON or code blocks. Output only Markdown prose and tables.
- If the draft already states "I don't have enough information...", keep that message unchanged.

Question:\n{{question}}\n\nDraftAnswer:\n{{answer}}\n\nReturn JSON with the final Markdown string as {"answer": "..."}.`
});

function tsvToPipeTable(text) {
  try {
    const lines = String(text||'').split(/\r?\n/);
    // Detect contiguous TSV block: at least 3 lines with 2+ tabs, and no pipe symbol in those lines
    const tsvLines = lines.filter(l => l.includes('\t') && (l.match(/\t/g)||[]).length >= 2 && !l.includes('|'));
    if (tsvLines.length >= 3) {
      const rows = tsvLines.map(l => l.split('\t').map(s => s.trim()));
      const widths = rows[0].map((_,i) => Math.max(...rows.map(r => (r[i]||'').length), 3));
      const pad = (s,w) => {
        const v = String(s||'');
        return v + ' '.repeat(Math.max(0, w - v.length));
      };
      const toRow = (r) => `| ${r.map((c,i)=>pad(c, widths[i])).join(' | ')} |`;
      const header = toRow(rows[0]);
      const sep = `| ${widths.map(w=>'-'.repeat(w)).join(' | ')} |`;
      const body = rows.slice(1).map(toRow).join('\n');
      return `${header}\n${sep}\n${body}`;
    }
    return text;
  } catch { return text; }
}

export async function finalizeAnswer(question, answer) {
  try {
    const pre = tsvToPipeTable(answer);
    const res = await safeLLMCall(() => finalizer({ question: String(question||'').slice(0,2000), answer: String(pre||'').slice(0,8000) }), { maxRetries: 2 });
    if (res && typeof res.answer === 'string' && res.answer.trim()) return res.answer.trim();
  } catch {}
  // Fallback: strip JSON code blocks if present
  try {
    const cleaned = String(tsvToPipeTable(answer)||'').replace(/```json[\s\S]*?```/gi, '').trim();
    return cleaned || answer;
  } catch { return answer; }
}

export default { finalizeAnswer };
