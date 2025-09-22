import { ai } from '../ai.js';
import { safeLLMCall } from '../lib/ai-service.js';
import { z } from 'zod';

/**
 * Base Agent class for specialized question handling
 */
class BaseAgent {
  constructor(agentConfig) {
    this.config = agentConfig;
    
    // Define a default prompt template if none is provided
    const promptTemplate = agentConfig.prompt_template || `
You are an intelligent document assistant helping users find and understand information in their documents.

Question: {{question}}

Relevant Documents:
{{#each documents}}
Document {{@index}}:
Title: {{this.title}}
Name: {{this.name}}
Date: {{this.documentDate}}
Sender: {{this.sender}}
Receiver: {{this.receiver}}
Type: {{this.documentType}}
Category: {{this.category}}
Content: {{this.content}}

{{/each}}

Conversation History:
{{#each conversation}}
{{this.role}}: {{this.content}}
{{/each}}

Please provide a helpful, natural language answer strictly based on the documents provided.
Formatting requirements:
- The "answer" MUST be GitHub-Flavored Markdown (GFM).
- Use headings, bullet lists, and tables where helpful.
- Do NOT include the JSON wrapper in the answer; only put Markdown in the answer field.
Rules:
- Use only the provided document content; do not fabricate facts or refer to external sources.
- Prefer evidence from documents that match the requested document type or category when apparent.
- If none of the provided snippets support an answer, say so and suggest a precise follow-up (e.g., a filter or date range).
- Be concise but informative.

Respond ONLY with valid JSON in this exact format:
{
  "answer": "<your_answer_here>",
  "confidence": <confidence_score_between_0_and_1>
}

Example response:
{
  "answer": "Based on the documents provided, I found 3 contracts related to your query. The most recent one is titled 'Service Agreement' from January 15, 2023.",
  "confidence": 0.85
}`;

    this.agentPrompt = ai.definePrompt({
      name: `${agentConfig.key}Agent`,
      input: {
        schema: z.object({
          question: z.string(),
          documents: z.array(z.object({
            id: z.string().optional(),
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
      prompt: promptTemplate
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
      const result = await safeLLMCall(
        async () => this.agentPrompt({
          question,
          documents: relevantDocs,
          conversation: conversation.slice(-3)
        }),
        { maxRetries: 3 }
      );

      // Ensure we always have an answer field
      let answer = result.answer;
      if (!answer || answer.trim() === '') {
        // Generate a default answer based on the documents found
        answer = this.generateDefaultAnswer(relevantDocs, question);
      }

      return {
        answer: answer,
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
    return documents.slice(0, 10).map(doc => ({
      docId: doc.id || '',
      docName: doc.title || doc.name || 'Untitled Document',
      snippet: doc.content ? doc.content.substring(0, 200) + '...' : 'Document content'
    }));
  }

  /**
   * Fallback message when no relevant documents found
   */
  getFallbackMessage() {
    return `I couldn't find relevant ${this.config.key} information in your documents to answer this question.`;
  }

  /**
   * Generate a default answer when AI fails to generate one
   */
  generateDefaultAnswer(documents, question) {
    if (!documents || documents.length === 0) {
      return "I couldn't find any relevant documents to answer your question.";
    }

    // Generate a human-readable summary of the documents found
    const docCount = documents.length;
    const docList = documents.slice(0, 10).map((doc, index) => 
      `${index + 1}. ${doc.title || doc.name || 'Untitled Document'}`
    ).join('\n');

    // Try to infer the intent from the question
    const q = (question || '').toLowerCase();
    let intent = 'found';
    
    if (q.includes('show') || q.includes('list') || q.includes('find') || q.includes('search')) {
      intent = 'found';
    } else if (q.includes('what') || q.includes('how') || q.includes('why') || q.includes('explain')) {
      intent = 'analyzed';
    } else if (q.includes('compare') || q.includes('difference')) {
      intent = 'compared';
    } else {
      intent = 'found';
    }

    return `I ${intent} ${docCount} relevant document${docCount !== 1 ? 's' : ''} based on your query:\n\n${docList}${docCount > 10 ? `\n... and ${docCount - 10} more` : ''}`;
  }
}

export default BaseAgent;
