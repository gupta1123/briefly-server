/**
 * Query Planner: derive structured filters and boosts from routing result/entities
 * without relying on data hygiene.
 */

function normalize(str) {
  return String(str || '').toLowerCase();
}

// Lightweight synonym map for document types (no DB changes)
const TYPE_SYNONYMS = new Map([
  ['inspection', ['inspection', 'inspection report', 'visit report', 'site inspection', 'mpcb inspection', 'compliance visit', 'inspection note', 'inspection findings']],
  ['invoice', ['invoice', 'bill', 'receipt', 'payment']],
  ['legal', ['legal', 'agreement', 'contract', 'notice']],
  ['financial', ['financial', 'budget', 'cost', 'quotation', 'demand note']],
]);

import { definePrompt, safeLLMCall } from './ai-service.js';
import { z } from 'zod';

// LLM prompt to extract structured filters (sender, receiver, date)
const filterPrompt = definePrompt({
  name: 'extractMetadataFilters',
  input: {
    schema: z.object({ question: z.string() })
  },
  output: {
    schema: z.object({
      sender: z.string().nullable().optional(),
      receiver: z.string().nullable().optional(),
      date: z.string().nullable().optional(), // e.g., "today", "yesterday", "last month", "this month", "2024-09", "2024-09-12"
    })
  },
  prompt: `You extract simple metadata filters from a short request. Return JSON with keys sender, receiver, date (a natural phrase like "today", "yesterday", "last month", "this month", or an ISO date YYYY-MM-DD or YYYY-MM).

Question: {{{question}}}

Return ONLY JSON.`
});

function toIsoDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function parseRelativeDateRange(input) {
  const s = String(input || '').trim().toLowerCase();
  const now = new Date();
  now.setHours(0,0,0,0);
  if (!s) return null;
  if (s === 'today') return { start: toIsoDate(now), end: toIsoDate(now) };
  if (s === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1); return { start: toIsoDate(d), end: toIsoDate(d) };
  }
  if (s === 'last week') {
    const d = new Date(now);
    const dow = d.getDay(); // 0..6
    const lastMonday = new Date(d); lastMonday.setDate(d.getDate() - dow - 6);
    const lastSunday = new Date(lastMonday); lastSunday.setDate(lastMonday.getDate() + 6);
    return { start: toIsoDate(lastMonday), end: toIsoDate(lastSunday) };
  }
  if (s === 'this month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: toIsoDate(first), end: toIsoDate(now) };
  }
  if (s === 'last month') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: toIsoDate(first), end: toIsoDate(last) };
  }
  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { start: s, end: s };
  // Try YYYY-MM
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y,m] = s.split('-').map(Number);
    const first = new Date(y, m-1, 1);
    const last = new Date(y, m, 0);
    return { start: toIsoDate(first), end: toIsoDate(last) };
  }
  return null;
}

export async function extractFilters(question) {
  try {
    const out = await safeLLMCall(() => filterPrompt({ question }), { maxRetries: 2 });
    const sender = out?.sender ? String(out.sender).trim() : null;
    const receiver = out?.receiver ? String(out.receiver).trim() : null;
    const date = out?.date ? parseRelativeDateRange(out.date) : null;
    return { sender, receiver, dateRange: date };
  } catch {
    return { sender: null, receiver: null, dateRange: null };
  }
}

export function buildQueryPlan(question, routingResult) {
  const plan = {
    terms: [],
    boostTerms: [],
    typeFilters: [],
    categoryFilters: [],
    dateRange: null,
    sender: null,
    receiver: null,
    entities: routingResult?.entities || [],
  };

  const q = normalize(question);
  const ents = Array.isArray(routingResult?.entities) ? routingResult.entities : [];

  // Extract doc_type from entities
  const typeEnts = ents.filter(e => normalize(e.type) === 'document_type');
  for (const te of typeEnts) {
    const val = normalize(te.value);
    // Expand synonyms
    for (const [canon, syns] of TYPE_SYNONYMS.entries()) {
      if (syns.some(s => val.includes(normalize(s)))) {
        plan.typeFilters.push(canon);
        plan.boostTerms.push(...syns);
      }
    }
    // If nothing matched, still use the raw value as a filter term
    if (plan.typeFilters.length === 0 && val) {
      plan.typeFilters.push(val);
    }
  }

  // Add expanded terms from router (if present)
  if (routingResult?.expandedQuery?.terms) {
    plan.terms.push(...routingResult.expandedQuery.terms.map(normalize));
  }

  // Heuristic: if question mentions 'inspection', add inspection filter
  if (q.includes('inspection')) plan.typeFilters.push('inspection');

  // De-duplicate
  plan.terms = Array.from(new Set(plan.terms.filter(Boolean)));
  plan.boostTerms = Array.from(new Set(plan.boostTerms.filter(Boolean)));
  plan.typeFilters = Array.from(new Set(plan.typeFilters.filter(Boolean)));
  plan.categoryFilters = Array.from(new Set(plan.categoryFilters.filter(Boolean)));

  return plan;
}

export default { buildQueryPlan };
