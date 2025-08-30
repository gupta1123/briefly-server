import BaseAgent from './base-agent.js';

class FinancialAgent extends BaseAgent {
  constructor(agentConfig) {
    super(agentConfig);
  }

  /**
   * Filter documents for financial content - be more aggressive
   */
  async filterRelevantDocuments(documents) {
    return documents.filter(doc => {
      const title = (doc.title || '').toLowerCase();
      const type = (doc.documentType || doc.type || '').toLowerCase();
      const category = (doc.category || '').toLowerCase();
      const content = (doc.content || '').toLowerCase();
      const tags = (doc.tags || []).map(tag => tag.toLowerCase());

      // Financial document types
      const financialTypes = [
        'invoice', 'bill', 'receipt', 'payment', 'budget', 'financial',
        'statement', 'expense', 'cost', 'fee', 'charge', 'amount',
        'project', 'estimate', 'quotation', 'proposal', 'tender'
      ];

      // Financial keywords
      const financialKeywords = [
        'cost', 'price', 'amount', 'budget', 'expense', 'revenue', 'profit',
        'crore', 'lakh', 'rupees', 'dollars', 'currency', 'financial',
        'total', 'subtotal', 'grand total', 'net amount', 'gross amount'
      ];

      // Check document type
      const hasFinancialType = financialTypes.some(term =>
        type.includes(term) || category.includes(term)
      );

      // Check tags
      const hasFinancialTags = tags.some(tag =>
        financialTypes.some(term => tag.includes(term)) ||
        financialKeywords.some(term => tag.includes(term))
      );

      // Check title for financial keywords
      const hasFinancialTitle = financialKeywords.some(keyword =>
        title.includes(keyword)
      );

      // Check for monetary symbols or amounts in content/title
      const hasMonetaryContent = content &&
        (content.includes('₹') ||
         content.includes('$') ||
         content.includes('amount') ||
         content.includes('total') ||
         content.includes('cost') ||
         content.includes('budget') ||
         /\d+[\.,]\d{2}/.test(content) ||
         /\b\d+(\.\d+)?\s*(crore|lakh|rupees|dollars)\b/i.test(content));

      // More lenient filtering - if any financial indicator is present
      return hasFinancialType || hasFinancialTags || hasFinancialTitle || hasMonetaryContent;
    });
  }

  /**
   * Financial-specific fallback message
   */
  getFallbackMessage() {
    return "I couldn't find any financial documents (invoices, bills, budgets, receipts) in your collection to analyze this financial question.";
  }
}

export default FinancialAgent;
