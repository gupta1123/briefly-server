import TrueAIAgent from './true-ai-agent.js';

/**
 * Research True AI Agent - Autonomous deep investigation
 * 
 * This is a genuine AI agent for intelligent research, NOT rule-based inquiry.
 */
class ResearchTrueAIAgent extends TrueAIAgent {
  constructor(config) {
    super(config);
    this.type = 'research-true-ai';
    this.specialization = 'intelligent_deep_investigation';
  }

  /**
   * Autonomous research through AI reasoning
   */
  async process(question, documents, conversation = [], context = {}) {
    console.log(`🔬 Research True AI Agent: Autonomous deep investigation for "${question}"`);
    
    // Use the base AI agent's autonomous processing
    const result = await super.process(question, documents, conversation, {
      ...context,
      specialization: 'deep_research',
      research_approach: 'comprehensive_investigation_and_analysis'
    });
    
    // Add research-specific enhancements
    const enhancedResult = await this.enhanceResearchCapabilities(result, question, documents);
    
    return enhancedResult;
  }

  /**
   * Enhance research capabilities through AI reasoning
   */
  async enhanceResearchCapabilities(baseResult, question, documents) {
    const enhancementPrompt = `
Enhance the research results with investigative intelligence.

BASE RESULT: ${JSON.stringify(baseResult, null, 2)}
ORIGINAL QUESTION: "${question}"
DOCUMENTS FOR RESEARCH: ${documents.length} documents

INTELLIGENTLY enhance by:
1. Applying advanced investigative research techniques
2. Identifying hidden patterns and connections
3. Generating deep investigative insights
4. Creating research methodologies and frameworks
5. Suggesting research expansion opportunities
6. Providing evidence validation approaches
7. Recommending further research directions
8. Ensuring research integrity and validity
9. Creating comprehensive research reports
10. Identifying research gaps and limitations

Think like a research scientist - investigate thoroughly, validate evidence, and generate comprehensive insights.
`;

    const enhancement = await this.callLLM(enhancementPrompt, {
      temperature: 0.3,
      max_tokens: 1200
    });
    
    return {
      ...baseResult,
      investigative_insights: enhancement.investigative_insights,
      hidden_patterns: enhancement.hidden_patterns,
      research_methodologies: enhancement.research_methodologies,
      evidence_validation: enhancement.evidence_validation,
      research_expansion: enhancement.research_expansion,
      research_integrity: enhancement.research_integrity,
      comprehensive_reports: enhancement.comprehensive_reports,
      research_gaps: enhancement.research_gaps,
      limitations_analysis: enhancement.limitations_analysis
    };
  }
}

export default ResearchTrueAIAgent;