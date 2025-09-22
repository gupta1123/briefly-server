/**
 * Simple task conformance and grounding checks
 * Returns { ok, warnings: string[], answer }
 */
export function verifyAnswer({ task, answer, citations, targetDocId }) {
  const warnings = [];
  let text = String(answer || '').trim();

  // Remove boilerplate phrasing
  text = text.replace(/^\s*i\s+analy[sz]ed\b[\s\S]*/i, (m) => {
    warnings.push('Removed boilerplate intro.');
    return text.replace(m, '').trim();
  });

  const hasCitations = Array.isArray(citations) && citations.length > 0;
  const docOk = hasCitations ? citations.every(c => !targetDocId || c.docId === targetDocId) : true;

  if (!docOk) warnings.push('Some citations are outside the scoped document.');

  if (task === 'SummarizeDoc') {
    if (text.split(/\s+/).length < 12) warnings.push('Summary may be too short.');
    if (!hasCitations) warnings.push('Summary lacks citations.');
  }

  if (task === 'QAAboutDoc') {
    if (!hasCitations && !/i\s+don'?t\s+have\s+enough/i.test(text)) warnings.push('QA answer lacks citations.');
  }

  return { ok: warnings.length === 0, warnings, answer: text };
}

