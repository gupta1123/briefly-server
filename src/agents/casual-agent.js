import BaseAgent from './base-agent.js';

class CasualAgent extends BaseAgent {
  constructor(agentConfig) {
    super(agentConfig);
  }

  /**
   * Process casual conversation with contextual awareness
   */
  async process(question, documents, conversation = []) {
    try {
      // For casual conversation, we don't need to filter documents
      // Instead, we focus on the conversation context
      
      // Generate a natural, contextual response
      const response = await this.generateCasualResponse(question, conversation);
      
      return {
        answer: response,
        confidence: 0.9, // High confidence for casual conversation
        citations: [] // No citations needed for casual conversation
      };
    } catch (error) {
      console.error('Casual agent error:', error);
      return {
        answer: "Hello! I'm here to help you with your document queries. Feel free to ask me about any documents you have.",
        confidence: 0.8,
        citations: []
      };
    }
  }

  /**
   * Generate a contextual casual response
   */
  async generateCasualResponse(question, conversation) {
    // Simple pattern matching for common greetings
    const q = question.toLowerCase().trim();
    
    // Greetings
    if (/(^|\b)(hi|hello|hey|what's up|whats up|howdy)(\b|$)/.test(q)) {
      return "Hello there! I'm your document assistant. I can help you find, analyze, and understand your documents. What would you like to know about your documents?";
    }
    
    // How are you
    if (/(how are you|how're you|how do you do|how's it going)/.test(q)) {
      return "I'm doing great, thank you for asking! I'm here and ready to help you with your document-related questions. What can I assist you with today?";
    }
    
    // Thank you
    if (/(thank you|thanks|thx|thankyou)/.test(q)) {
      return "You're welcome! I'm happy to help. Is there anything else about your documents you'd like to explore?";
    }
    
    // Goodbye
    if (/(bye|goodbye|see you|later|farewell)/.test(q)) {
      return "Goodbye! Feel free to come back anytime if you have more document questions. Have a great day!";
    }
    
    // General questions not about documents
    if (/(what can you do|what are you for|what is this|what is this for)/.test(q)) {
      return "I'm an intelligent document assistant designed to help you work with your documents. I can:\n\n" +
             "• Find specific documents by title, sender, date, or content\n" +
             "• Answer questions about document contents\n" +
             "• Extract key information from documents\n" +
             "• Compare similar documents\n" +
             "• Analyze document content\n" +
             "• Help you understand complex documents\n\n" +
             "What would you like to do with your documents?";
    }
    
    // Default casual response with document context
    return "I'm here to help you with your documents. You can ask me questions like:\n\n" +
           "• \"Find documents from last month\"\n" +
           "• \"What's in the contract with Microsoft?\"\n" +
           "• \"Show me invoices from ABC Company\"\n" +
           "• \"Compare the Q1 and Q2 reports\"\n\n" +
           "What would you like to know about your documents?";
  }

  /**
   * Casual conversation doesn't need document filtering
   */
  async filterRelevantDocuments(documents) {
    return []; // No documents needed for casual conversation
  }

  /**
   * Casual conversation fallback message
   */
  getFallbackMessage() {
    return "I'm here to help you with your documents. Feel free to ask me questions about your files!";
  }
}

export default CasualAgent;