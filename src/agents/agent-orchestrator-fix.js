import AgentRouter from './agent-router.js';
import BaseAgent from './base-agent.js';
import MetadataAgent from './metadata-agent.js';
import FinancialAgent from './financial-agent.js';
import ResumeAgent from './resume-agent.js';
import LegalAgent from './legal-agent.js';

/**
 * Fixed Agent Orchestrator - Properly connects document search with agent processing
 */
class FixedAgentOrchestrator {
  constructor() {
    this.agents = new Map();
  }

  /**
   * Initialize agents with their configurations
   */
  async initializeAgents(db) {
    console.log('🔧 Fixed Agent Orchestrator: Loading agent configurations from database');

    const { data: agentConfigs, error } = await db
      .from('agent_types')
      .select('*')
      .eq('is_active', true);

    if (error) {
      console.error('❌ Fixed Agent Orchestrator: Failed to load agent configurations:', error);
      throw new Error('Failed to load agent configurations');
    }

    console.log('📊 Fixed Agent Orchestrator: Found', agentConfigs?.length || 0, 'active agents');

    for (const config of agentConfigs) {
      console.log('⚙️ Fixed Agent Orchestrator: Initializing agent:', config.key, '-', config.name);
      const AgentClass = this.getAgentClass(config.key);
      if (AgentClass) {
        this.agents.set(config.key, new AgentClass(config));
        console.log('✅ Fixed Agent Orchestrator: Successfully initialized:', config.key);
      } else {
        console.warn('⚠️ Fixed Agent Orchestrator: No class found for agent type:', config.key);
      }
    }

    console.log('🎯 Fixed Agent Orchestrator: Agent initialization complete');
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
   * Process a question using the appropriate agent with proper document context
   */
  async processQuestion(db, question, documents, conversation = [], agentType = null) {
    try {
      console.log('🎭 Fixed Agent Orchestrator: Processing question:', question);
      console.log('📋 Fixed Agent Orchestrator: Agent type provided:', agentType);

      // If agent type not specified, use router to determine
      if (!agentType) {
        console.log('🔄 Fixed Agent Orchestrator: Using router to determine agent type');
        const routingResult = await AgentRouter.routeQuestion(question, conversation);
        agentType = routingResult.agentType;
        console.log('🎯 Fixed Agent Orchestrator: Router selected agent:', agentType);
      }

      // Ensure agents are initialized
      if (this.agents.size === 0) {
        console.log('⚙️ Fixed Agent Orchestrator: Initializing agents');
        await this.initializeAgents(db);
        console.log('✅ Fixed Agent Orchestrator: Initialized', this.agents.size, 'agents');
      }

      // Get the appropriate agent
      const agent = this.agents.get(agentType);
      if (!agent) {
        console.error('❌ Fixed Agent Orchestrator: Agent not found:', agentType);
        console.log('📋 Available agents:', Array.from(this.agents.keys()));
        throw new Error(`Agent not found: ${agentType}`);
      }

      console.log('🤖 Fixed Agent Orchestrator: Processing with agent:', agent.config.name);

      // Process the question with proper document context
      const result = await agent.process(question, documents, conversation);

      console.log('✅ Fixed Agent Orchestrator: Processing complete');

      return {
        ...result,
        agentType,
        agentName: agent.config.name
      };
    } catch (error) {
      console.error('❌ Fixed Agent orchestration error:', error);
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
   * Search for relevant documents based on agent type and question
   */
  async searchRelevantDocuments(db, orgId, question, agentType, allowSemantic = true) {
    console.log('🔍 Fixed Agent Orchestrator: Searching documents for agent:', agentType);
    
    let relevantDocuments = [];

    if (agentType === 'metadata') {
      // Metadata agent: search documents by metadata only
      const { data, error } = await db
        .from('documents')
        .select('id, title, filename, sender, receiver, document_date, document_type, category, tags')
        .eq('org_id', orgId)
        .limit(20);
      if (!error && Array.isArray(data)) {
        relevantDocuments = data;
      }
    } else {
      // Other agents: use semantic search if allowed
      if (allowSemantic) {
        try {
          const embedding = await this.embedQuery(question).catch(() => null);
          if (embedding) {
            const { data: chunks, error: matchErr } = await db.rpc('match_doc_chunks', {
              p_org_id: orgId,
              p_query_embedding: embedding,
              p_match_count: 24,
              p_similarity_threshold: 0
            });

            if (!matchErr && Array.isArray(chunks)) {
              const docIds = [...new Set(chunks.map(c => c.doc_id))];
              if (docIds.length > 0) {
                const { data: docs, error: docsErr } = await db
                  .from('documents')
                  .select('id, title, filename, sender, receiver, document_date, document_type, category, tags, content')
                  .eq('org_id', orgId)
                  .in('id', docIds);

                if (!docsErr && Array.isArray(docs)) {
                  // Add snippets to documents
                  relevantDocuments = (docs || []).map(doc => {
                    const docChunks = chunks.filter(c => c.doc_id === doc.id);
                    return {
                      ...doc,
                      content: docChunks.map(c => c.content).join('\n---\n')
                    };
                  });
                }
              }
            }
          }
        } catch (e) {
          console.warn('Semantic search failed, falling back to lexical search:', e);
        }
      }

      // Fallback to lexical search if semantic failed or not allowed
      if (relevantDocuments.length === 0) {
        const s = `%${question.trim()}%`;
        const { data, error } = await db
          .from('documents')
          .select('id, title, filename, subject, sender, receiver, document_date, type, category, tags')
          .eq('org_id', orgId)
          .or(`title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},type.ilike.${s},category.ilike.${s}`)
          .order('uploaded_at', { ascending: false })
          .limit(12);
        
        if (!error && Array.isArray(data)) {
          relevantDocuments = data.map(d => ({
            id: d.id,
            title: d.title || d.filename || 'Untitled',
            filename: d.filename,
            sender: d.sender,
            receiver: d.receiver,
            documentDate: d.document_date,
            documentType: d.type || d.document_type,
            category: d.category,
            tags: d.tags || [],
            subject: d.subject,
            content: [d.title, d.subject, d.sender, d.receiver, d.type, d.category].filter(Boolean).join(' — ').slice(0, 500)
          }));
        }
      }
    }

    console.log('📚 Fixed Agent Orchestrator: Found', relevantDocuments.length, 'relevant documents');
    return relevantDocuments;
  }

  /**
   * Embed query for semantic search
   */
  async embedQuery(text) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    
    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings error: ${res.status} ${errTxt}`);
    }
    
    const data = await res.json();
    const emb = data?.data?.[0]?.embedding;
    return Array.isArray(emb) ? emb : null;
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

export default new FixedAgentOrchestrator();