// Tool Registry: declarative metadata about available tools

export const ToolRegistry = {
  metadata_search: {
    name: 'metadata_search',
    description: 'Filter documents by metadata: title, subject, sender, receiver, date, category, type.',
    cost: 'low', latency: 'low',
    bestFor: ['ListDocs', 'MetadataQA'],
    inputs: ['filters', 'limit'], outputs: ['docList'],
  },
  vector_search: {
    name: 'vector_search',
    description: 'Find top semantic chunks per doc using match_doc_chunks RPC.',
    cost: 'medium', latency: 'medium',
    bestFor: ['ContentQA', 'FieldExtract', 'Summarize'],
    inputs: ['question', 'docIds', 'limit'], outputs: ['chunksByDoc'],
  },
  rerank: {
    name: 'rerank',
    description: 'Reduce candidate docs with lightweight reranking.',
    cost: 'low', latency: 'low',
    bestFor: ['ContentQA', 'Compare'],
    inputs: ['question', 'documents'], outputs: ['topDocuments'],
  },
  qa_doc: {
    name: 'qa_doc',
    description: 'Answer a question grounded in top chunks of a document.',
    cost: 'high', latency: 'medium',
    bestFor: ['ContentQA'],
    inputs: ['doc', 'question', 'chunks'], outputs: ['answer', 'citations'],
  },
  extract_numeric: {
    name: 'extract_numeric',
    description: 'Deterministic numeric extraction for patterns (e.g., counts near key terms).',
    cost: 'low', latency: 'low',
    bestFor: ['FieldExtract'],
    inputs: ['question', 'chunks'], outputs: ['number', 'supportingSnippet'],
  },
  summarize_doc: {
    name: 'summarize_doc',
    description: 'Summarize a document from chunks/extractions.',
    cost: 'high', latency: 'medium',
    bestFor: ['Summarize'],
    inputs: ['doc', 'chunks'], outputs: ['summary', 'citations'],
  },
  linked_docs: {
    name: 'linked_docs',
    description: 'Retrieve linked/related documents (versions, references).',
    cost: 'low', latency: 'low',
    bestFor: ['Linked'],
    inputs: ['docId'], outputs: ['linkedList'],
  },
  folder_count: {
    name: 'folder_count',
    description: 'Count documents in a folder scope.',
    cost: 'low', latency: 'low',
    bestFor: ['DocCount'],
    inputs: ['allowedDocIds'], outputs: ['count'],
  },
  answer_verify: {
    name: 'answer_verify',
    description: 'Verify and normalize answers and citations.',
    cost: 'low', latency: 'low',
    bestFor: ['All'],
    inputs: ['answer', 'citations'], outputs: ['answer'],
  },
};

export function listTools() { return Object.values(ToolRegistry); }
export function getTool(name) { return ToolRegistry[name] || null; }

