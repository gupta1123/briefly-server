import TrueAIAgent from './true-ai-agent.js';

/**
 * Analysis True AI Agent - Autonomous multi-document reasoning
 * 
 * This is a genuine AI agent for intelligent document analysis, NOT rule-based processing.
 */
class AnalysisTrueAIAgent extends TrueAIAgent {
  constructor(config) {
    super(config);
    this.type = 'analysis-true-ai';
    this.specialization = 'intelligent_multi_document_analysis';
  }

  /**
   * Autonomous document analysis through AI reasoning
   */
  async process(question, documents, conversation = [], context = {}) {
    console.log(`📊 Analysis True AI Agent: Autonomous multi-document analysis for "${question}"`);
    
    // Use the base AI agent's autonomous processing
    const result = await super.process(question, documents, conversation, {
      ...context,
      specialization: 'document_analysis',
      analytical_approach: 'deep_reasoning_and_insight_generation'
    });
    
    // Add analysis-specific enhancements
    const enhancedResult = await this.enhanceAnalysisCapabilities(result, question, documents);
    
    return enhancedResult;
  }

  /**
   * Enhance analysis capabilities through AI reasoning
   */
  async enhanceAnalysisCapabilities(baseResult, question, documents) {
    const enhancementPrompt = `
Enhance the document analysis results with analytical intelligence.

BASE RESULT: ${JSON.stringify(baseResult, null, 2)}
ORIGINAL QUESTION: "${question}"
DOCUMENTS FOR ANALYSIS: ${documents.length} documents

INTELLIGENTLY enhance by:
1. Applying advanced analytical reasoning techniques
2. Identifying complex patterns and correlations
3. Generating deep insights beyond surface observations
4. Creating analytical frameworks for understanding
5. Suggesting analytical methodologies
6. Providing analytical validation approaches
7. Recommending further analytical investigations

Think like a research scientist - identify patterns, generate hypotheses, and validate insights.
`;

    const enhancement = await this.callLLM(enhancementPrompt, {
      temperature: 0.3,
      max_tokens: 1200
    });
    
    return {
      ...baseResult,
      analytical_insights: enhancement.analytical_insights,
      pattern_identification: enhancement.pattern_identification,
      correlation_analysis: enhancement.correlation_analysis,
      hypothesis_generation: enhancement.hypothesis_generation,
      analytical_framework: enhancement.analytical_framework,
      validation_approaches: enhancement.validation_approaches,
      further_investigations: enhancement.further_investigations
    };
  }
}

export default AnalysisTrueAIAgent;