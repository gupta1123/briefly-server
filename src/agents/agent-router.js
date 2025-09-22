import { ai } from '../ai.js';
import { z } from 'zod';

/**
 * Agent Router - Decides which specialized agent should handle a question
 */
class AgentRouter {
  constructor() {
    this.routerPrompt = ai.definePrompt({
      name: 'agentRouter',
      input: {
                schema: z.object({
          question: z.string(),
          conversation: z.array(z.object({
            role: z.string().optional(),
            content: z.string().optional(),
        })).optional(),
        })
      },
      output: {
        schema: z.object({
          agentType: z.enum(['metadata', 'content', 'financial', 'resume', 'legal', 'casual']),
          confidence: z.number().min(0).max(1),
          reasoning: z.string(),
        })
      },
      prompt: `You are an intelligent router that analyzes questions and assigns them to the most appropriate specialized agent.

Available agents:
- metadata: Questions about document properties (dates, senders, receivers, types, categories, filenames)
- content: Questions requiring deep analysis of document content and text
- financial: Questions about money, costs, budgets, expenses, revenues, profits, amounts, pricing, financial calculations
- resume: Questions about CVs, resumes, candidate information, work experience, qualifications, skills
- legal: Questions about legal documents (contracts, agreements, notices, terms, obligations, rights)
- casual: Casual conversation, greetings, small talk, general questions not related to documents

ROUTING GUIDELINES:

CASUAL CONVERSATION (use casual agent):
- Greetings like "Hello", "Hi", "Hey", "What's up"
- Small talk like "How are you?", "How's it going?"
- General questions not about documents
- Thank you, goodbye, etc.

FINANCIAL QUESTIONS (use financial agent):
- Any mention of money, costs, budgets, expenses, revenues, profits
- Words like: cost, price, amount, budget, expense, revenue, profit, crore, lakh, rupees, dollars, financial
- Project costs, expansion costs, total costs, construction costs
- Financial calculations, amounts, pricing information
- Budget allocations, financial planning, cost analysis

Examples of financial questions:
- "What was the project cost?"
- "How much did the expansion cost?"
- "What is the total budget?"
- "What are the expenses for this quarter?"
- "What was the existing project cost, the project cost for the proposed expansion, and the total project cost in Crores?"

CONTENT QUESTIONS (use content agent):
- General questions about document content
- Summaries, explanations, analysis of text
- What happened, who did what, when did it occur

METADATA QUESTIONS (use metadata agent):
- Who sent this document?
- When was this created?
- What type of document is this?
- What are the file properties?

Analyze the question and conversation context to determine:
1. Which agent is most appropriate
2. Your confidence level (0.0 to 1.0) - be confident (0.8+) for clear document questions, lower confidence (0.3-0.6) for casual conversation
3. Brief reasoning for your choice

Question: {{{question}}}

Conversation History:
{{#each conversation}}
{{role}}: {{{content}}}
{{/each}}

Return your analysis in the specified JSON format.`
    });
  }

  /**
   * Route a question to the appropriate agent
   */
  async routeQuestion(question, conversation = []) {
    try {
      console.log('🔍 Agent Router: Routing question:', question);

      const recentConversation = conversation.slice(-3); // Last 3 messages for context

      const result = await this.routerPrompt({
        question,
        conversation: recentConversation
      });

      console.log('🤖 Agent Router: AI Response:', result);

      // Ensure we have a valid agent type
      const agentType = result?.agentType || 'content';
      const confidence = result?.confidence || 0.5;

      console.log('🎯 Agent Router: Selected agent:', agentType, 'with confidence:', confidence);

      return {
        agentType,
        confidence,
        reasoning: result?.reasoning || 'AI routing decision',
        intent: this.mapAgentToIntent(agentType),
        primaryAgent: agentType
      };
    } catch (error) {
      console.error('❌ Agent routing failed:', error);
      // Fallback to content agent
      return {
        agentType: 'content',
        confidence: 0.5,
        reasoning: 'Fallback due to routing error: ' + error.message,
        intent: 'ContentQA',
        primaryAgent: 'content'
      };
    }
  }

  /**
   * Map agent type to legacy intent for compatibility
   */
  mapAgentToIntent(agentType) {
    const mapping = {
      'metadata': 'Metadata',
      'content': 'ContentQA',
      'financial': 'Analytics',
      'resume': 'ContentQA',
      'legal': 'ContentQA'
    };
    return mapping[agentType] || 'ContentQA';
  }

  /**
   * Get agent configuration from database
   */
  async getAgentConfig(db, agentType) {
    const { data, error } = await db
      .from('agent_types')
      .select('*')
      .eq('key', agentType)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      throw new Error(`Agent configuration not found for: ${agentType}`);
    }

    return data;
  }
}

export default new AgentRouter();
