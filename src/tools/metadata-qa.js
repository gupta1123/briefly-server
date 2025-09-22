/**
 * Answer metadata questions about a single document based on DB fields
 * @param {Object} params { db, orgId, docId, question }
 * Returns { answer, citations }
 */
export async function metadataQA({ db, orgId, docId, question }) {
  const { data: row } = await db
    .from('documents')
    .select('title, subject, sender, receiver, document_date, category, type, filename, description')
    .eq('org_id', orgId)
    .eq('id', docId)
    .maybeSingle();
  if (!row) return { answer: 'Document not found.', citations: [] };

  const lower = String(question || '').toLowerCase();
  const parts = [];
  function add(label, value) { if (value) parts.push(`${label}: ${value}`); }

  // If user hints at specific field, answer directly; else provide concise set
  if (/(title|name)\b/i.test(question)) add('Title', row.title || row.filename);
  if (/subject\b/i.test(question)) add('Subject', row.subject);
  if (/sender\b/i.test(question)) add('Sender', row.sender);
  if (/receiver\b/i.test(question)) add('Receiver', row.receiver);
  if (/(date|document date)\b/i.test(question)) add('Date', row.document_date);
  if (/(category|type)\b/i.test(question)) { add('Category', row.category); add('Type', row.type); }
  if (/filename\b/i.test(question)) add('Filename', row.filename);
  if (/summary|description\b/i.test(question)) add('Description', row.description);

  if (parts.length === 0) {
    add('Title', row.title || row.filename);
    add('Subject', row.subject);
    add('Sender', row.sender);
    add('Receiver', row.receiver);
    add('Date', row.document_date);
    add('Category', row.category);
    add('Type', row.type);
  }

  const answer = parts.join('\n');
  // Metadata citations: include a short pseudo-citation pointing to the field (UI can link to doc)
  const citations = [ { docId, docName: row.title || row.filename || 'Document', snippet: parts.slice(0, 2).join(' | ').slice(0, 400) } ];
  return { answer, citations };
}

