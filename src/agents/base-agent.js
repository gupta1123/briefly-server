import { ai } from '../ai.js';
import { z } from 'zod';

/**
 * Base Agent class for specialized question handling
 */
class BaseAgent {
  constructor(agentConfig) {
    this.config = agentConfig;
    this.agentPrompt = ai.definePrompt({
      name: `${agentConfig.key}Agent`,
      input: {
        schema: z.object({
          question: z.string(),
          documents: z.array(z.object({
            id: z.string(),
            title: z.string().nullable(),
            name: z.string(),
            content: z.string().nullable(),
            documentDate: z.string().nullable(),
            sender: z.string().nullable(),
            receiver: z.string().nullable(),
            documentType: z.string().nullable(),
            category: z.string().nullable(),
            tags: z.array(z.string()).nullable(),
          })),
          conversation: z.array(z.object({
            role: z.string().optional(),
            content: z.string().optional(),
          })).optional(),
        })
      },
      output: {
        schema: z.object({
          answer: z.string(),
          confidence: z.number().min(0).max(1),
          citations: z.array(z.object({
            docId: z.string(),
            docName: z.string(),
            snippet: z.string(),
          })).optional(),
        })
      },
      prompt: agentConfig.prompt_template
    });
  }

  /**
   * Process a question using this agent's specialized logic
   */
  async process(question, documents, conversation = []) {
    try {
      // Filter documents relevant to this agent type
      const relevantDocs = await this.filterRelevantDocuments(documents);

      if (relevantDocs.length === 0) {
        return {
          answer: this.getFallbackMessage(),
          confidence: 0.3,
          citations: []
        };
      }

      // Call the AI with agent-specific prompt
      const result = await this.agentPrompt({
        question,
        documents: relevantDocs,
        conversation: conversation.slice(-3) // Last 3 messages
      });

      return {
        answer: result.answer,
        confidence: result.confidence || 0.8,
        citations: result.citations || this.generateCitations(relevantDocs)
      };
    } catch (error) {
      console.error(`${this.config.key} agent error:`, error);
      return {
        answer: `I encountered an error while processing your question with the ${this.config.name}. Please try rephrasing your question.`,
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Filter documents relevant to this agent's specialty
   * Override in subclasses for agent-specific filtering
   */
  async filterRelevantDocuments(documents) {
    return documents; // Default: return all documents
  }

  /**
   * Generate basic citations from documents
   */
  generateCitations(documents) {
    return documents.slice(0, 3).map(doc => ({
      docId: doc.id,
      docName: doc.title || doc.name,
      snippet: doc.content ? doc.content.substring(0, 200) + '...' : 'Document content'
    }));
  }

  /**
   * Fallback message when no relevant documents found
   */
  getFallbackMessage() {
    return `I couldn't find relevant ${this.config.key} information in your documents to answer this question.`;
  }
}

export default BaseAgent;
