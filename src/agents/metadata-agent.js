import BaseAgent from './base-agent.js';

class MetadataAgent extends BaseAgent {
  constructor(agentConfig) {
    super(agentConfig);
  }

  /**
   * Filter for metadata-only questions - no need for content analysis
   */
  async filterRelevantDocuments(documents) {
    // Metadata agent can work with any documents that have metadata
    // Just ensure they have at least some metadata fields
    return documents.filter(doc =>
      doc.documentDate ||
      doc.sender ||
      doc.receiver ||
      doc.documentType ||
      doc.category ||
      (doc.tags && doc.tags.length > 0)
    );
  }

  /**
   * Override to provide metadata-specific fallback
   */
  getFallbackMessage() {
    return "I couldn't find sufficient metadata in your documents to answer this question. Try asking about document content instead.";
  }
}

export default MetadataAgent;
