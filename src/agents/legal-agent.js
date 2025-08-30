import BaseAgent from './base-agent.js';

class LegalAgent extends BaseAgent {
  constructor(agentConfig) {
    super(agentConfig);
  }

  /**
   * Filter documents for legal content
   */
  async filterRelevantDocuments(documents) {
    return documents.filter(doc => {
      const title = (doc.title || doc.name || '').toLowerCase();
      const type = (doc.documentType || doc.type || '').toLowerCase();
      const category = (doc.category || '').toLowerCase();
      const content = (doc.content || '').toLowerCase();

      // Legal document indicators
      const legalKeywords = [
        'contract', 'agreement', 'legal', 'law', 'notice', 'complaint',
        'petition', 'decree', 'order', 'judgment', 'settlement', 'memorandum',
        'terms', 'conditions', 'policy', 'regulation', 'act', 'clause',
        'party', 'obligation', 'right', 'liability', 'breach', 'termination'
      ];

      // Legal entities and parties
      const legalEntities = [
        'ltd', 'limited', 'pvt', 'private', 'corporation', 'company',
        'partnership', 'association', 'society', 'trust', 'firm'
      ];

      // Check title and type
      const hasLegalTitle = legalKeywords.some(keyword =>
        title.includes(keyword) || type.includes(keyword) || category.includes(keyword)
      );

      // Check for legal content patterns
      const hasLegalContent = content &&
        (legalKeywords.some(keyword => content.includes(keyword)) ||
         legalEntities.some(entity => content.includes(entity)) ||
         /\b(section|article|clause)\s+\d+\b/i.test(content) || // Section/Article references
         /\bparty\s+(first|second|third)\b/i.test(content) || // Party references
         /\bthis\s+agreement\b/i.test(content)); // Legal language patterns

      return hasLegalTitle || hasLegalContent;
    });
  }

  /**
   * Legal-specific fallback message
   */
  getFallbackMessage() {
    return "I couldn't find any legal documents (contracts, agreements, notices) in your collection to analyze this legal question.";
  }
}

export default LegalAgent;
