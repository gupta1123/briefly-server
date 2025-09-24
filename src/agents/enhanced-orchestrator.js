import AgentRouter from './agent-router.js';
import BaseAgent from './base-agent.js';
import MetadataAgent from './metadata-agent.js';
import CasualAgent from './casual-agent.js';


/**
 * Enhanced Agent Orchestrator - Advanced multi-agent coordination and orchestration
 */
class EnhancedAgentOrchestrator {
  constructor() {
    this.agents = new Map();
    this.agentDependencies = new Map();
    this.executionHistory = [];
    this.initializedAt = 0;
  }

  /**
   * Initialize agents with their configurations
   */
  async initializeAgents(db) {
    // Avoid repeated prompt registration within a TTL
    const NOW = Date.now();
    const TTL_MS = 5 * 60 * 1000; // 5 minutes
    if (this.agents.size > 0 && this.initializedAt && (NOW - this.initializedAt) < TTL_MS) {
      return;
    }
    console.log('🔧 Enhanced Agent Orchestrator: Loading agent configurations from database');

    const { data: agentConfigs, error } = await db
      .from('agent_types')
      .select('*')
      .eq('is_active', true);

    if (error) {
      console.error('❌ Enhanced Agent Orchestrator: Failed to load agent configurations:', error);
      throw new Error('Failed to load agent configurations');
    }

    console.log('📊 Enhanced Agent Orchestrator: Found', agentConfigs?.length || 0, 'active agents');

    for (const config of agentConfigs) {
      console.log('⚙️ Enhanced Agent Orchestrator: Initializing agent:', config.key, '-', config.name);
      const AgentClass = this.getAgentClass(config.key);
      if (AgentClass) {
        this.agents.set(config.key, new AgentClass(config));
        console.log('✅ Enhanced Agent Orchestrator: Successfully initialized:', config.key);
      } else {
        console.warn('⚠️ Enhanced Agent Orchestrator: No class found for agent type:', config.key);
      }
    }

    console.log('🎯 Enhanced Agent Orchestrator: Agent initialization complete');
    this.initializedAt = Date.now();
  }

  /**
   * Get the appropriate agent class for an agent type
   */
  getAgentClass(agentType) {
    // Use legacy agent classes
    const agentClasses = {
      'metadata': MetadataAgent,
      'content': BaseAgent, // Content agent uses base functionality
      'casual': CasualAgent
    };
    
    return agentClasses[agentType] || BaseAgent;
  }

  /**
   * Get the appropriate true AI agent class for an agent type
   */

  /**
   * Process a question using single agent (backward compatibility)
   */
  async processQuestion(db, question, documents, conversation = [], agentType = null) {
    try {
      console.log('🎭 Enhanced Agent Orchestrator: Processing question:', question);
      console.log('📋 Enhanced Agent Orchestrator: Agent type provided:', agentType);

      // If agent type not specified, use router to determine
      if (!agentType) {
        console.log('🔄 Enhanced Agent Orchestrator: Using router to determine agent type');
        const routingResult = await AgentRouter.routeQuestion(question, conversation);
        agentType = routingResult.agentType;
        console.log('🎯 Enhanced Agent Orchestrator: Router selected agent:', agentType);
      }

      // Ensure agents are initialized
      if (this.agents.size === 0) {
        console.log('⚙️ Enhanced Agent Orchestrator: Initializing agents');
        await this.initializeAgents(db);
        console.log('✅ Enhanced Agent Orchestrator: Initialized', this.agents.size, 'agents');
      }

      // Get the appropriate agent (fallback to 'content' if unknown)
      let agent = this.agents.get(agentType);
      if (!agent) {
        console.warn('⚠️ Enhanced Agent Orchestrator: Unknown agent type, falling back to content:', agentType);
        agentType = 'content';
        agent = this.agents.get(agentType);
      }

      console.log('🤖 Enhanced Agent Orchestrator: Processing with agent:', agent.config.name);

      // Process the question
      const result = await agent.process(question, documents, conversation);

      console.log('✅ Enhanced Agent Orchestrator: Processing complete');

      return {
        ...result,
        agentType,
        agentName: agent.config.name
      };
    } catch (error) {
      console.error('❌ Enhanced orchestration error:', error);
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
   * Process a question using multiple agents with coordination
   */
  async processWithCoordination(db, question, documents, conversation = [], routingResult = null, options = {}) {
    try {
      console.log('🎭 Enhanced Agent Orchestrator: Coordinated processing for question:', question);

      // Ensure agents are initialized
      if (this.agents.size === 0) {
        console.log('⚙️ Enhanced Agent Orchestrator: Initializing agents');
        await this.initializeAgents(db);
        console.log('✅ Enhanced Agent Orchestrator: Initialized', this.agents.size, 'agents');
      }

      // Determine which agents to use based on the question
      const agentPlan = await this.createAgentExecutionPlan(question, conversation, routingResult);
      
      console.log('📋 Enhanced Agent Orchestrator: Execution plan:', agentPlan);

      // Execute agents according to the plan
      const tunedOptions = {
        perAgentTimeoutMs: options.perAgentTimeoutMs || Number(process.env.ORCH_PER_AGENT_TIMEOUT_MS || 8000),
        overallTimeoutMs: options.overallTimeoutMs || Number(process.env.ORCH_OVERALL_TIMEOUT_MS || 15000),
        secondaryMax: Number(process.env.ORCH_SECONDARY_MAX || options.secondaryMax || 1),
      };
      const results = await this.executeAgentPlan(agentPlan, question, documents, conversation, tunedOptions);

      // Synthesize final response from multiple agent outputs
      let finalResult = await this.synthesizeResults(results, question, conversation);

      // Critic loop (single refinement; can be disabled via env)
      const MIN_PRIMARY_CONFIDENCE = Number(process.env.ORCH_MIN_PRIMARY_CONFIDENCE || 0.7);
      const ENABLE_CRITIC_REFINEMENT = String(process.env.ORCH_ENABLE_CRITIC_REFINEMENT || 'true').toLowerCase() !== 'false';
      const needRefine = ENABLE_CRITIC_REFINEMENT && (!finalResult || (typeof finalResult.confidence === 'number' && finalResult.confidence < MIN_PRIMARY_CONFIDENCE) || !(finalResult.citations && finalResult.citations.length > 0));
      if (needRefine && Array.isArray(documents) && documents.length > 0) {
        try {
          const keywords = new Set(
            (routingResult?.entities || [])
              .filter(e => (e.type === 'document_type' || e.type === 'topic'))
              .map(e => String(e.value || '').toLowerCase())
          );
          // Heuristic type filters from entities
          if (routingResult?.expandedQuery?.terms) {
            for (const t of routingResult.expandedQuery.terms) {
              const s = String(t || '').toLowerCase();
              if (s.includes('inspect')) keywords.add('inspect');
            }
          }
          const refinedDocs = documents.filter(d => {
            const t = String(d.documentType || '').toLowerCase();
            const c = String(d.content || '').toLowerCase();
            if (keywords.size === 0) return true;
            for (const k of keywords) {
              if (!k) continue;
              if (t.includes(k) || c.includes(k)) return true;
            }
            return false;
          });
          if (refinedDocs.length > 0 && refinedDocs.length <= documents.length) {
            const retry = await this.processQuestion(null, question, refinedDocs, conversation, agentPlan.primary);
            if (retry && ((retry.confidence || 0) > (finalResult.confidence || 0) || (retry.citations || []).length > (finalResult.citations || []).length)) {
              finalResult = { ...retry, agentType: agentPlan.primary };
            }
          }
        } catch (e) {
          console.warn('Critic refinement failed:', e);
        }
      }

      console.log('✅ Enhanced Agent Orchestrator: Coordinated processing complete');

      return finalResult;
    } catch (error) {
      console.error('❌ Enhanced coordinated orchestration error:', error);
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
   * Create execution plan for multiple agents
   */
  async createAgentExecutionPlan(question, conversation = [], routingResult = null) {
    // Use provided routing result if available; otherwise route once here
    const routed = routingResult || await AgentRouter.routeQuestion(question, conversation);
    // For now, we'll create a simple plan with primary and secondary agents
    // Normalize unknown agent types to 'content'
    const normalize = (t) => {
      const allowed = new Set(['metadata','content','casual']);
      const v = String(t || '').toLowerCase();
      return allowed.has(v) ? v : 'content';
    };
    const primaryAgent = normalize(routed.agentType || 'content');
    
    // Determine secondary agents based on question context
    const secondaryAgents = this.determineSecondaryAgents(question, primaryAgent).map(normalize);
    
    return {
      primary: primaryAgent,
      secondary: secondaryAgents,
      executionMode: 'sequential' // Could be 'parallel' or 'sequential'
    };
  }

  /**
   * Determine secondary agents based on question context
   */
  determineSecondaryAgents(question, primaryAgent) {
    const secondaryAgents = [];
    const q = question.toLowerCase();

    // Add metadata agent for questions that might need metadata
    if (primaryAgent !== 'metadata' && 
        (q.includes('title') || q.includes('sender') || q.includes('date') || 
         q.includes('category') || q.includes('type'))) {
      secondaryAgents.push('metadata');
    }

    // Add content agent for complex questions
    if (primaryAgent !== 'content' && 
        (q.includes('compare') || q.includes('analyze') || q.includes('difference') || 
         q.includes('similar') || q.includes('relationship') || q.includes('find') || 
         q.includes('search') || q.includes('look for') || q.includes('show') || 
         q.includes('list'))) {
      secondaryAgents.push('content');
    }

    return [...new Set(secondaryAgents)]; // Remove duplicates
  }

  /**
   * Execute agent plan
   */
  async executeAgentPlan(agentPlan, question, documents, conversation = [], options = {}) {
    const results = {
      primary: null,
      secondary: {},
      executionTrace: []
    };

    const startTime = Date.now();
    const PER_AGENT_TIMEOUT_MS = options.perAgentTimeoutMs || 8000;
    const OVERALL_TIMEOUT_MS = options.overallTimeoutMs || 15000;
    const SECONDARY_MAX = options.secondaryMax || 1;
    const DISABLE_SECONDARIES = String(process.env.ORCH_DISABLE_SECONDARIES || 'false').toLowerCase() === 'true';
    const MIN_PRIMARY_CONFIDENCE = Number(process.env.ORCH_MIN_PRIMARY_CONFIDENCE || 0.7);
    const SECONDARY_ONLY_IF_NO_CITATIONS = String(process.env.ORCH_SECONDARY_ONLY_IF_NO_CITATIONS || 'true').toLowerCase() !== 'false';

    const runWithTimeout = (p, ms, label) => new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ timeout: true, error: new Error(`${label || 'task'} timed out`) });
        }
      }, ms);
      p.then((val) => {
        if (!settled) { settled = true; clearTimeout(t); resolve(val); }
      }).catch((err) => {
        if (!settled) { settled = true; clearTimeout(t); resolve({ error: err }); }
      });
    });

    try {
      // Execute primary agent
      console.log('🤖 Enhanced Agent Orchestrator: Executing primary agent:', agentPlan.primary);
      const primaryStart = Date.now();
      
      results.primary = await runWithTimeout(
        this.processQuestion(null, question, documents, conversation, agentPlan.primary),
        Math.min(PER_AGENT_TIMEOUT_MS, OVERALL_TIMEOUT_MS),
        `primary:${agentPlan.primary}`
      );
      if (results.primary && results.primary.answer === undefined && results.primary.timeout) {
        results.primary = { answer: 'Timed out answering. Please try again.', confidence: 0.1, citations: [] };
      }
      
      results.executionTrace.push({
        agent: agentPlan.primary,
        type: 'primary',
        duration: Date.now() - primaryStart,
        success: true
      });

      // Early exit on high-confidence primary
      if (results.primary && typeof results.primary.confidence === 'number' && results.primary.confidence >= MIN_PRIMARY_CONFIDENCE) {
        results.totalDuration = Date.now() - startTime;
        return results;
      }

      // Budget check
      if ((Date.now() - startTime) >= OVERALL_TIMEOUT_MS) {
        results.totalDuration = Date.now() - startTime;
        return results;
      }

      // Determine if we should execute secondary agents (need-based)
      let runSecondaries = !DISABLE_SECONDARIES && SECONDARY_MAX > 0;
      if (SECONDARY_ONLY_IF_NO_CITATIONS && Array.isArray(results.primary?.citations) && results.primary.citations.length > 0) {
        runSecondaries = false;
      }
      if (results.primary && typeof results.primary.confidence === 'number' && results.primary.confidence >= (MIN_PRIMARY_CONFIDENCE - 0.05)) {
        runSecondaries = false;
      }
      // Execute secondary agents (capped and gated)
      const secondaries = runSecondaries ? agentPlan.secondary.slice(0, SECONDARY_MAX) : [];
      for (const agentType of secondaries) {
        console.log('🤖 Enhanced Agent Orchestrator: Executing secondary agent:', agentType);
        const secondaryStart = Date.now();
        
        try {
          results.secondary[agentType] = await runWithTimeout(
            this.processQuestion(null, question, documents, conversation, agentType),
            Math.max(500, Math.min(PER_AGENT_TIMEOUT_MS, OVERALL_TIMEOUT_MS - (Date.now() - startTime))),
            `secondary:${agentType}`
          );
          
          results.executionTrace.push({
            agent: agentType,
            type: 'secondary',
            duration: Date.now() - secondaryStart,
            success: true
          });
        } catch (error) {
          console.error(`❌ Enhanced Agent Orchestrator: Secondary agent ${agentType} failed:`, error);
          results.executionTrace.push({
            agent: agentType,
            type: 'secondary',
            duration: Date.now() - secondaryStart,
            success: false,
            error: error.message
          });
        }
        if ((Date.now() - startTime) >= OVERALL_TIMEOUT_MS) break;
      }

      results.totalDuration = Date.now() - startTime;
      return results;
    } catch (error) {
      console.error('❌ Enhanced Agent Orchestrator: Agent plan execution failed:', error);
      throw error;
    }
  }

  /**
   * Synthesize results from multiple agents with consensus mechanisms
   */
  async synthesizeResults(agentResults, question, conversation = []) {
    // In a real implementation, this would use AI to combine results intelligently
    // For now, we'll use a simple approach that prioritizes the primary agent's result
    // but incorporates insights from secondary agents
    
    const primaryResult = agentResults.primary;
    const secondaryResults = agentResults.secondary;
    
    // If we only have a primary result, return it
    if (!secondaryResults || Object.keys(secondaryResults).length === 0) {
      return primaryResult;
    }
    
    // Combine insights from secondary agents
    const insights = [];
    for (const [agentType, result] of Object.entries(secondaryResults)) {
      if (!result || typeof result.answer !== 'string') continue;
      const hasCitations = Array.isArray(result.citations) && result.citations.length > 0;
      if (result.confidence > 0.4 && hasCitations) {
        insights.push({ agent: agentType, answer: result.answer, confidence: result.confidence, citations: result.citations });
      }
    }
    
    // Apply consensus mechanisms to resolve conflicts
    const consensusResult = this.applyConsensusMechanisms(primaryResult, insights, question);
    
    // If we have insights, create a combined response
    if (insights.length > 0) {
      // Use consensus result if available, otherwise combine insights
      const combinedAnswer = consensusResult ? 
        consensusResult.answer : 
        this.combineAgentInsights(primaryResult, insights, question);
      
      // Combine citations from all agents
      const filteredSecondaries = Object.fromEntries(insights.map(i => [i.agent, secondaryResults[i.agent]]));
      const allCitations = this.combineCitations(primaryResult, filteredSecondaries);
      
      // Calculate combined confidence (weighted average or consensus confidence)
      const combinedConfidence = consensusResult ? 
        consensusResult.confidence : 
        this.calculateCombinedConfidence(primaryResult, insights);
      
      return {
        ...primaryResult,
        answer: combinedAnswer,
        confidence: combinedConfidence,
        citations: allCitations,
        agentInsights: insights,
        consensusResult: consensusResult,
        executionTrace: agentResults.executionTrace
      };
    }
    
    // Fallback to primary result
    return {
      ...primaryResult,
      executionTrace: agentResults.executionTrace
    };
  }

  /**
   * Combine insights from multiple agents
   */
  combineAgentInsights(primaryResult, insights, question) {
    // Simple approach: Add insights as additional context to the primary answer
    let combinedAnswer = primaryResult.answer;
    
    if (insights.length > 0) {
      combinedAnswer += '\n\nAdditional insights from other analysis:\n';
      insights.forEach((insight, index) => {
        combinedAnswer += `\n${index + 1}. From ${insight.agent} analysis: ${insight.answer.substring(0, 200)}${insight.answer.length > 200 ? '...' : ''}`;
      });
    }
    
    return combinedAnswer;
  }

  /**
   * Combine citations from multiple agents
   */
  combineCitations(primaryResult, secondaryResults) {
    const allCitations = new Map();
    
    // Add primary citations
    if (primaryResult.citations && Array.isArray(primaryResult.citations)) {
      primaryResult.citations.forEach(citation => {
        allCitations.set(citation.docId, citation);
      });
    }
    
    // Add secondary citations
    for (const result of Object.values(secondaryResults)) {
      if (result.citations && Array.isArray(result.citations)) {
        result.citations.forEach(citation => {
          // Only add if not already present
          if (!allCitations.has(citation.docId)) {
            allCitations.set(citation.docId, citation);
          }
        });
      }
    }
    
    return Array.from(allCitations.values());
  }

  /**
   * Calculate combined confidence from multiple agents
   */
  calculateCombinedConfidence(primaryResult, insights) {
    // Weighted average - primary result has higher weight
    const primaryWeight = 0.7;
    const secondaryWeight = 0.3 / insights.length;
    
    let totalConfidence = primaryResult.confidence * primaryWeight;
    
    insights.forEach(insight => {
      totalConfidence += insight.confidence * secondaryWeight;
    });
    
    return Math.min(1.0, totalConfidence); // Cap at 1.0
  }

  /**
   * Apply consensus mechanisms to resolve conflicts between agent responses
   */
  applyConsensusMechanisms(primaryResult, insights, question) {
    // Simple consensus mechanism - look for agreement among high-confidence responses
    if (insights.length === 0) {
      return null;
    }
    
    // Group insights by similarity of answers
    const groupedInsights = this.groupSimilarInsights(insights);
    
    // Find the group with the highest total confidence
    let bestGroup = null;
    let highestConfidence = 0;
    
    for (const [groupId, group] of Object.entries(groupedInsights)) {
      const totalConfidence = group.reduce((sum, insight) => sum + insight.confidence, 0);
      if (totalConfidence > highestConfidence) {
        highestConfidence = totalConfidence;
        bestGroup = group;
      }
    }
    
    // If we have a clear consensus group, use its representative answer
    if (bestGroup && bestGroup.length > 1) {
      // Sort by confidence and take the highest
      bestGroup.sort((a, b) => b.confidence - a.confidence);
      const consensusAnswer = bestGroup[0].answer;
      
      return {
        answer: consensusAnswer,
        confidence: Math.min(1.0, highestConfidence / insights.length * 1.5), // Boost confidence for consensus
        consensusGroup: bestGroup.map(insight => insight.agent)
      };
    }
    
    return null;
  }

  /**
   * Group similar insights based on answer similarity
   */
  groupSimilarInsights(insights) {
    const groups = {};
    let groupId = 0;
    
    for (const insight of insights) {
      let foundGroup = false;
      
      // Check if this insight is similar to any existing group
      for (const [id, group] of Object.entries(groups)) {
        // Simple similarity check - in a real implementation, this would use embeddings
        if (this.areAnswersSimilar(insight.answer, group[0].answer)) {
          group.push(insight);
          foundGroup = true;
          break;
        }
      }
      
      // If no similar group found, create a new one
      if (!foundGroup) {
        groups[++groupId] = [insight];
      }
    }
    
    return groups;
  }

  /**
   * Simple answer similarity check
   */
  areAnswersSimilar(answer1, answer2) {
    // In a real implementation, this would use embeddings for semantic similarity
    // For now, use simple string similarity
    const a1 = answer1.toLowerCase().trim();
    const a2 = answer2.toLowerCase().trim();
    
    // Check if one answer is contained in the other
    if (a1.includes(a2) || a2.includes(a1)) {
      return true;
    }
    
    // Check for common keywords
    const words1 = a1.split(/\s+/);
    const words2 = a2.split(/\s+/);
    const commonWords = words1.filter(word => words2.includes(word));
    
    // If more than 30% of words are common, consider them similar
    const similarityRatio = commonWords.length / Math.max(words1.length, words2.length);
    return similarityRatio > 0.3;
  }

  /**
   * Execute agents in parallel
   */
  async executeAgentsInParallel(agentTypes, question, documents, conversation = []) {
    console.log('⚡ Enhanced Agent Orchestrator: Executing agents in parallel:', agentTypes);
    
    const promises = agentTypes.map(async (agentType) => {
      try {
        const result = await this.processQuestion(null, question, documents, conversation, agentType);
        return { agentType, result, success: true };
      } catch (error) {
        console.error(`❌ Enhanced Agent Orchestrator: Parallel agent ${agentType} failed:`, error);
        return { agentType, error: error.message, success: false };
      }
    });
    
    const results = await Promise.allSettled(promises);
    
    const successfulResults = [];
    const failedResults = [];
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.success) {
        successfulResults.push(result.value);
      } else {
        failedResults.push({
          agentType: agentTypes[index],
          error: result.status === 'fulfilled' ? result.value.error : result.reason.message,
          success: false
        });
      }
    });
    
    return { successful: successfulResults, failed: failedResults };
  }

  /**
   * Chain agents together for sequential processing
   */
  async chainAgents(agentSequence, question, documents, conversation = []) {
    console.log('🔗 Enhanced Agent Orchestrator: Chaining agents:', agentSequence);
    
    let currentQuestion = question;
    let currentDocuments = documents;
    let chainResults = [];
    
    for (const agentType of agentSequence) {
      try {
        console.log(`🔗 Enhanced Agent Orchestrator: Executing agent in chain: ${agentType}`);
        const result = await this.processQuestion(null, currentQuestion, currentDocuments, conversation, agentType);
        
        chainResults.push({
          agentType,
          result,
          success: true
        });
        
        // Update question and documents for next agent if needed
        if (result.answer && result.answer.length > 0) {
          currentQuestion = `Based on the previous analysis: "${result.answer.substring(0, 100)}...", ${question}`;
        }
        
        // If the agent returned specific documents, use those
        // This would need to be implemented based on agent capabilities
      } catch (error) {
        console.error(`❌ Enhanced Agent Orchestrator: Chained agent ${agentType} failed:`, error);
        chainResults.push({
          agentType,
          error: error.message,
          success: false
        });
        
        // Decide whether to continue or break the chain based on error
        // For now, we'll continue but this could be configurable
      }
    }
    
    return chainResults;
  }

  /**
   * Implement fallback agent strategies
   */
  async executeWithFallbackStrategy(agentTypes, question, documents, conversation = []) {
    console.log('🔄 Enhanced Agent Orchestrator: Executing with fallback strategy:', agentTypes);
    
    for (const agentType of agentTypes) {
      try {
        console.log(`🔄 Enhanced Agent Orchestrator: Trying agent ${agentType}`);
        const result = await this.processQuestion(null, question, documents, conversation, agentType);
        
        // If the result has reasonable confidence, return it
        if (result.confidence > 0.5) {
          console.log(`✅ Enhanced Agent Orchestrator: Fallback strategy succeeded with ${agentType}`);
          return {
            ...result,
            fallbackUsed: agentType,
            success: true
          };
        }
      } catch (error) {
        console.error(`❌ Enhanced Agent Orchestrator: Fallback agent ${agentType} failed:`, error);
        // Continue to next fallback agent
      }
    }
    
    // If all fallbacks fail, return a generic error response
    return {
      answer: 'I couldn\'t find a suitable answer to your question. Please try rephrasing or ask something else.',
      confidence: 0.1,
      citations: [],
      fallbackUsed: null,
      success: false
    };
  }

  /**
   * Agent communication protocol - allow agents to share information
   */
  async communicateBetweenAgents(agent1Result, agent2Type, question, documents, conversation = []) {
    // In a more advanced implementation, this would allow agents to communicate
    // For now, we'll simulate communication by passing one agent's results to another
    
    console.log(`コミュニケ Enhanced Agent Orchestrator: Agent communication from result to ${agent2Type}`);
    
    try {
      // Create a new question that incorporates the first agent's result
      const contextualQuestion = `Based on this information: "${agent1Result.answer.substring(0, 200)}...", ${question}`;
      
      // Process with the second agent
      const secondResult = await this.processQuestion(null, contextualQuestion, documents, conversation, agent2Type);
      
      return {
        firstAgentResult: agent1Result,
        secondAgentResult: secondResult,
        communicationSuccess: true
      };
    } catch (error) {
      console.error(`❌ Enhanced Agent Orchestrator: Agent communication failed:`, error);
      return {
        firstAgentResult: agent1Result,
        communicationSuccess: false,
        error: error.message
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

export default EnhancedAgentOrchestrator;
