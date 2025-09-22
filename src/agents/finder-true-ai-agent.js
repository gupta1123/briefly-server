import TrueAIAgent from './true-ai-agent.js';
import BaseAgent from './base-agent.js';

/**
 * Finder True AI Agent - Autonomous document discovery
 * 
 * This is a genuine AI agent for intelligent document finding, NOT rule-based search.
 */
class FinderTrueAIAgent extends TrueAIAgent {
  constructor(config) {
    super(config);
    this.type = 'finder-true-ai';
    this.specialization = 'intelligent_document_discovery';
  }

  /**
   * Autonomous document finding through AI reasoning
   */
  async process(question, documents, conversation = [], context = {}) {
    console.log(`🔍 Finder True AI Agent: Autonomous document discovery for "${question}"`);
    
    // Use the base AI agent's autonomous processing
    const result = await super.process(question, documents, conversation, {
      ...context,
      specialization: 'document_discovery',
      discovery_approach: 'semantic_understanding_first'
    });
    
    // Add finder-specific enhancements
    const enhancedResult = await this.enhanceFinderCapabilities(result, question, documents);
    
    return enhancedResult;
  }

  /**
   * Enhance finder capabilities through AI reasoning
   */
  async enhanceFinderCapabilities(baseResult, question, documents) {
    const enhancementPrompt = `
Enhance the document discovery results with finder-specific intelligence.

BASE RESULT: ${JSON.stringify(baseResult, null, 2)}
ORIGINAL QUESTION: "${question}"
AVAILABLE DOCUMENTS: ${documents.length} documents

INTELLIGENTLY enhance by:
1. Applying advanced semantic discovery techniques
2. Identifying implicit document relationships
3. Ranking results by discovery relevance
4. Suggesting related discovery avenues
5. Providing discovery strategy insights

Think like a master document detective - go beyond surface-level matching.

Respond ONLY with valid JSON in this exact format:
{
  "discovery_insights": ["<insight_1>", "<insight_2>"],
  "relationship_mapping": ["<relationship_1>", "<relationship_2>"],
  "discovery_strategy": "<strategy>",
  "related_avenues": ["<avenue_1>", "<avenue_2>"]
}`;

    const enhancement = await this.callLLM(enhancementPrompt, {
      temperature: 0.3,
      max_tokens: 1200
    });
    
    return {
      ...baseResult,
      discovery_insights: Array.isArray(enhancement?.discovery_insights) ? enhancement.discovery_insights : [],
      relationship_mapping: Array.isArray(enhancement?.relationship_mapping) ? enhancement.relationship_mapping : [],
      discovery_strategy: enhancement?.discovery_strategy || 'Standard discovery approach',
      related_avenues: Array.isArray(enhancement?.related_avenues) ? enhancement.related_avenues : []
    };
  }
}

export default FinderTrueAIAgent;