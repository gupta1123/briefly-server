import AgentRouter from './agent-router.js';
import BaseAgent from './base-agent.js';
import MetadataAgent from './metadata-agent.js';
import FinancialAgent from './financial-agent.js';
import ResumeAgent from './resume-agent.js';
import LegalAgent from './legal-agent.js';

/**
 * Agent Orchestrator - Manages all specialized agents and coordinates their work
 */
class AgentOrchestrator {
  constructor() {
    this.agents = new Map();
  }

  /**
   * Initialize agents with their configurations
   */
  async initializeAgents(db) {
    console.log('🔧 Agent Orchestrator: Loading agent configurations from database');

    const { data: agentConfigs, error } = await db
      .from('agent_types')
      .select('*')
      .eq('is_active', true);

    if (error) {
      console.error('❌ Agent Orchestrator: Failed to load agent configurations:', error);
      throw new Error('Failed to load agent configurations');
    }

    console.log('📊 Agent Orchestrator: Found', agentConfigs?.length || 0, 'active agents');

    for (const config of agentConfigs) {
      console.log('⚙️ Agent Orchestrator: Initializing agent:', config.key, '-', config.name);
      const AgentClass = this.getAgentClass(config.key);
      if (AgentClass) {
        this.agents.set(config.key, new AgentClass(config));
        console.log('✅ Agent Orchestrator: Successfully initialized:', config.key);
      } else {
        console.warn('⚠️ Agent Orchestrator: No class found for agent type:', config.key);
      }
    }

    console.log('🎯 Agent Orchestrator: Agent initialization complete');
  }

  /**
   * Get the appropriate agent class for an agent type
   */
  getAgentClass(agentType) {
    const agentClasses = {
      'metadata': MetadataAgent,
      'content': BaseAgent, // Content agent uses base functionality
      'financial': FinancialAgent,
      'resume': ResumeAgent,
      'legal': LegalAgent
    };

    return agentClasses[agentType] || BaseAgent;
  }

  /**
   * Process a question using the appropriate agent
   */
  async processQuestion(db, question, documents, conversation = [], agentType = null) {
    try {
      console.log('🎭 Agent Orchestrator: Processing question:', question);
      console.log('📋 Agent Orchestrator: Agent type provided:', agentType);

      // If agent type not specified, use router to determine
      if (!agentType) {
        console.log('🔄 Agent Orchestrator: Using router to determine agent type');
        const routingResult = await AgentRouter.routeQuestion(question, conversation);
        agentType = routingResult.agentType;
        console.log('🎯 Agent Orchestrator: Router selected agent:', agentType);
      }

      // Ensure agents are initialized
      if (this.agents.size === 0) {
        console.log('⚙️ Agent Orchestrator: Initializing agents');
        await this.initializeAgents(db);
        console.log('✅ Agent Orchestrator: Initialized', this.agents.size, 'agents');
      }

      // Get the appropriate agent
      const agent = this.agents.get(agentType);
      if (!agent) {
        console.error('❌ Agent Orchestrator: Agent not found:', agentType);
        console.log('📋 Available agents:', Array.from(this.agents.keys()));
        throw new Error(`Agent not found: ${agentType}`);
      }

      console.log('🤖 Agent Orchestrator: Processing with agent:', agent.config.name);

      // Process the question
      const result = await agent.process(question, documents, conversation);

      console.log('✅ Agent Orchestrator: Processing complete');

      return {
        ...result,
        agentType,
        agentName: agent.config.name
      };
    } catch (error) {
      console.error('❌ Agent orchestration error:', error);
      return {
        answer: 'I encountered an error while processing your question. Please try again.',
        confidence: 0.1,
        citations: [],
        agentType: 'error',
        agentName: 'Error Handler'
      };
    }
  }

  /**
   * Get available agent types
   */
  async getAvailableAgents(db) {
    const { data, error } = await db
      .from('agent_types')
      .select('key, name, description')
      .eq('is_active', true)
      .order('name');

    if (error) {
      throw new Error('Failed to fetch available agents');
    }

    return data || [];
  }

  /**
   * Get agent configuration
   */
  async getAgentConfig(db, agentType) {
    return await AgentRouter.getAgentConfig(db, agentType);
  }
}

export default new AgentOrchestrator();
