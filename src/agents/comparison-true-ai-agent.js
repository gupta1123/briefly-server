import TrueAIAgent from './true-ai-agent.js';

/**
 * Comparison True AI Agent - Autonomous document comparison
 * 
 * This is a genuine AI agent for intelligent document comparison, NOT rule-based analysis.
 */
class ComparisonTrueAIAgent extends TrueAIAgent {
  constructor(config) {
    super(config);
    this.type = 'comparison-true-ai';
    this.specialization = 'intelligent_document_comparison';
  }

  /**
   * Autonomous document comparison through AI reasoning
   */
  async process(question, documents, conversation = [], context = {}) {
    console.log(`🔄 Comparison True AI Agent: Autonomous document comparison for "${question}"`);
    
    // Use the base AI agent's autonomous processing
    const result = await super.process(question, documents, conversation, {
      ...context,
      specialization: 'document_comparison',
      comparison_approach: 'deep_analytical_understanding'
    });
    
    // Add comparison-specific enhancements
    const enhancedResult = await this.enhanceComparisonCapabilities(result, question, documents);
    
    return enhancedResult;
  }

  /**
   * Enhance comparison capabilities through AI reasoning
   */
  async enhanceComparisonCapabilities(baseResult, question, documents) {
    const enhancementPrompt = `
Enhance the document comparison results with comparison-specific intelligence.

BASE RESULT: ${JSON.stringify(baseResult, null, 2)}
ORIGINAL QUESTION: "${question}"
DOCUMENTS TO COMPARE: ${documents.length} documents

INTELLIGENTLY enhance by:
1. Applying advanced analytical comparison techniques
2. Identifying subtle differences and similarities
3. Generating comparative insights beyond surface level
4. Creating intelligent comparison matrices
5. Suggesting deeper analysis opportunities
6. Providing comparison strategy recommendations

Think like a master analyst - identify nuanced differences and profound similarities.
`;

    const enhancement = await this.callLLM(enhancementPrompt, {
      temperature: 0.3,
      max_tokens: 1200
    });
    
    return {
      ...baseResult,
      comparative_insights: enhancement.comparative_insights,
      difference_mapping: enhancement.difference_mapping,
      similarity_analysis: enhancement.similarity_analysis,
      comparison_strategy: enhancement.comparison_strategy,
      deeper_analysis_opportunities: enhancement.deeper_analysis_opportunities
    };
  }
}

export default ComparisonTrueAIAgent;