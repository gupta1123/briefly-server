import AgentRouter from './agent-router.js';
import BaseAgent from './base-agent.js';
import MetadataAgent from './metadata-agent.js';
import FinancialAgent from './financial-agent.js';
import ResumeAgent from './resume-agent.js';
import LegalAgent from './legal-agent.js';
import CasualAgent from './casual-agent.js';

// Import new True AI Agents
import TrueAIAgent from './true-ai-agent.js';
import FinderTrueAIAgent from './finder-true-ai-agent.js';
import ComparisonTrueAIAgent from './comparison-true-ai-agent.js';
import TimelineTrueAIAgent from './timeline-true-ai-agent.js';
import AnalysisTrueAIAgent from './analysis-true-ai-agent.js';
import ActionTrueAIAgent from './action-true-ai-agent.js';
import ResearchTrueAIAgent from './research-true-ai-agent.js';
import ComplianceTrueAIAgent from './compliance-true-ai-agent.js';

// Import enhanced orchestrator features
import EnhancedAgentOrchestrator from './enhanced-orchestrator.js';

/**
 * Agent Orchestrator - Manages all specialized agents and coordinates their work
 * Extended with multi-agent coordination capabilities
 */
class AgentOrchestrator {
  constructor() {
    this.agents = new Map();
    this.enhancedOrchestrator = EnhancedAgentOrchestrator;
    this.initializedAt = 0;
  }

  /**
   * Initialize agents with their configurations
   */
  async initializeAgents(db) {
    // Cache initialization to avoid repeated prompt registration
    const NOW = Date.now();
    const TTL_MS = 5 * 60 * 1000; // 5 minutes
    if (this.agents.size > 0 && this.initializedAt && (NOW - this.initializedAt) < TTL_MS) {
      return;
    }
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
    this.initializedAt = Date.now();
  }

  /**
   * Get the appropriate agent class for an agent type
   */
  getAgentClass(agentType) {
    // First try to get the true AI agent class
    const trueAIAgentClass = this.getTrueAIAgentClass(agentType);
    if (trueAIAgentClass) {
      return trueAIAgentClass;
    }
    
    // Fallback to legacy agent classes
    const agentClasses = {
      'metadata': MetadataAgent,
      'content': BaseAgent, // Content agent uses base functionality
      'financial': FinancialAgent,
      'resume': ResumeAgent,
      'legal': LegalAgent,
      'casual': CasualAgent
    };

    return agentClasses[agentType] || BaseAgent;
  }

  /**
   * Get the appropriate true AI agent class for an agent type
   */
  getTrueAIAgentClass(agentType) {
    const trueAIAgentClasses = {
      'finder': FinderTrueAIAgent,
      'comparison': ComparisonTrueAIAgent,
      'timeline': TimelineTrueAIAgent,
      'analysis': AnalysisTrueAIAgent,
      'action': ActionTrueAIAgent,
      'research': ResearchTrueAIAgent,
      'compliance': ComplianceTrueAIAgent
    };

    return trueAIAgentClasses[agentType] || null;
  }

  /**
   * Process a question using the appropriate agent (single agent processing)
   */
  async processQuestion(db, question, documents, conversation = [], agentType = null, routingResult = null) {
    try {
      console.log('🎭 Agent Orchestrator: Processing question:', question);
      console.log('📋 Agent Orchestrator: Agent type provided:', agentType);

      // If agent type not specified, use router to determine
      if (!agentType) {
        console.log('🔄 Agent Orchestrator: Using router to determine agent type');
        const routed = routingResult || await AgentRouter.routeQuestion(question, conversation);
        agentType = routed.agentType;
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
   * Process a question using coordinated multi-agent approach
   */
  async processWithCoordination(db, question, documents, conversation = [], routingResult = null, options = {}) {
    try {
      console.log('🎭 Agent Orchestrator: Coordinated processing for question:', question);
      
      // Ensure enhanced orchestrator is initialized (avoid duplicate prompt registration)
      if (this.enhancedOrchestrator?.initializeAgents) {
        try { await this.enhancedOrchestrator.initializeAgents(db); } catch {}
      }

      // Use enhanced orchestrator for coordinated processing
      return await this.enhancedOrchestrator.processWithCoordination(db, question, documents, conversation, routingResult, options);
    } catch (error) {
      console.error('❌ Coordinated agent orchestration error:', error);
      return {
        answer: 'I encountered an error while processing your question with coordinated agents. Please try again.',
        confidence: 0.1,
        citations: [],
        agentType: 'error',
        agentName: 'Coordinated Error Handler'
      };
    }
  }

  /**
   * Execute multiple agents in parallel
   */
  async executeParallel(db, agentTypes, question, documents, conversation = [], options = {}) {
    try {
      console.log('⚡ Agent Orchestrator: Executing agents in parallel:', agentTypes);
      
      if (this.enhancedOrchestrator?.initializeAgents) {
        try { await this.enhancedOrchestrator.initializeAgents(db); } catch {}
      }

      // Use enhanced orchestrator for parallel execution
      return await this.enhancedOrchestrator.executeAgentsInParallel(agentTypes, question, documents, conversation, options);
    } catch (error) {
      console.error('❌ Parallel agent execution error:', error);
      throw error;
    }
  }

  /**
   * Chain agents together for sequential processing
   */
  async chainAgents(db, agentSequence, question, documents, conversation = [], options = {}) {
    try {
      console.log('🔗 Agent Orchestrator: Chaining agents:', agentSequence);
      
      if (this.enhancedOrchestrator?.initializeAgents) {
        try { await this.enhancedOrchestrator.initializeAgents(db); } catch {}
      }

      // Use enhanced orchestrator for agent chaining
      return await this.enhancedOrchestrator.chainAgents(agentSequence, question, documents, conversation, options);
    } catch (error) {
      console.error('❌ Agent chaining error:', error);
      throw error;
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
