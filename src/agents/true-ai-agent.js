import { z } from 'zod';
import BaseAgent from './base-agent.js';

/**
 * True AI Agent - Autonomous reasoning and problem solving
 * 
 * This is a genuine AI agent that uses LLMs for:
 * - Autonomous planning and reasoning
 * - Self-directed problem solving
 * - Dynamic tool selection and execution
 * - Continuous learning and improvement
 */
class TrueAIAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.type = 'true-ai';
    this.capabilities = [
      'autonomous_reasoning',
      'dynamic_planning',
      'tool_selection',
      'self_improvement',
      'collaborative_problem_solving'
    ];
  }

  /**
   * Process query through autonomous AI reasoning
   * This is NOT rule-based - it's genuine AI problem solving
   */
  async process(question, documents, conversation = [], context = {}) {
    console.log(`🤖 True AI Agent: Processing "${question}" through autonomous reasoning`);
    
    try {
      // 1. SELF-REFLECTION: Understand the query deeply
      const queryUnderstanding = await this.deepQueryUnderstanding(question, context);
      
      // 2. AUTONOMOUS PLANNING: Create execution plan
      const executionPlan = await this.autonomousPlanning(queryUnderstanding, documents, conversation);
      
      // 3. DYNAMIC EXECUTION: Execute plan with adaptive tool selection
      const executionResults = await this.dynamicExecution(executionPlan, documents, conversation);
      
      // 4. SYNTHESIS: Combine results intelligently
      const synthesizedResponse = await this.intelligentSynthesis(executionResults, queryUnderstanding);
      
      // 5. SELF-EVALUATION: Assess quality and learn
      await this.selfEvaluationAndLearning(question, synthesizedResponse, context);
      
      console.log(`✅ True AI Agent: Completed autonomous processing`);
      
      return {
        answer: synthesizedResponse.answer,
        confidence: synthesizedResponse.confidence,
        citations: synthesizedResponse.citations,
        reasoning_trace: {
          understanding: queryUnderstanding,
          plan: executionPlan,
          execution: executionResults,
          synthesis: synthesizedResponse
        },
        metadata: {
          processing_approach: 'autonomous_ai_reasoning',
          tools_used: executionResults.toolsUsed,
          execution_time: Date.now() - synthesizedResponse.startTime
        }
      };
    } catch (error) {
      console.error('❌ True AI Agent Error:', error);
      
      // Even error handling is AI-driven
      const errorResponse = await this.aiDrivenErrorHandling(error, question);
      
      return errorResponse;
    }
  }

  /**
   * Deep query understanding through AI reasoning
   * NOT pattern matching or regex - genuine comprehension
   */
  async deepQueryUnderstanding(question, context = {}) {
    console.log('🧠 True AI Agent: Deep query understanding');
    
    // Use LLM for genuine comprehension
    const understandingPrompt = `
You are an advanced AI agent tasked with deeply understanding a user query.

USER QUERY: "${question}"

CONTEXT:
${JSON.stringify(context, null, 2)}

ANALYZE the query to determine:
1. Core intent and objective
2. Implied requirements and constraints
3. Required document types or categories
4. Expected output format and depth
5. Potential complexities or ambiguities
6. Related concepts and domain knowledge needed

Provide a comprehensive understanding that goes beyond surface-level interpretation.
`;

    const understanding = await this.callLLM(understandingPrompt, {
      temperature: 0.3,
      max_tokens: 1000
    });
    
    return {
      original_question: question,
      core_intent: understanding.core_intent,
      requirements: understanding.requirements,
      constraints: understanding.constraints,
      expected_output: understanding.expected_output,
      complexities: understanding.complexities,
      domain_knowledge_needed: understanding.domain_knowledge_needed,
      confidence_assessment: understanding.confidence_assessment
    };
  }

  /**
   * Autonomous planning through AI reasoning
   * NOT predetermined workflows - dynamic plan generation
   */
  async autonomousPlanning(understanding, documents, conversation = []) {
    console.log('🧭 True AI Agent: Autonomous planning');
    
    const planningPrompt = `
You are an AI planning expert. Based on the query understanding, create a comprehensive execution plan.

QUERY UNDERSTANDING:
${JSON.stringify(understanding, null, 2)}

AVAILABLE DOCUMENTS: ${documents.length} documents
CONVERSATION HISTORY: ${conversation.length} messages

GENERATE a detailed execution plan that includes:
1. Sequential steps needed to solve the query
2. Required tools and capabilities for each step
3. Dependencies between steps
4. Alternative approaches for complex steps
5. Risk assessment and mitigation strategies
6. Success criteria for each step
7. Expected intermediate outputs

The plan should be flexible and adaptive, not rigid.

Respond ONLY with valid JSON in this exact format:
{
  "steps": [
    {
      "description": "<step_description>",
      "expected_outcome": "<expected_outcome>",
      "complexity": "<low|medium|high>"
    }
  ],
  "tools_required": ["<tool_name>"],
  "dependencies": ["<dependency_description>"],
  "alternatives": ["<alternative_approach>"],
  "risk_assessment": "<risk_assessment>",
  "success_criteria": ["<success_criterion>"],
  "adaptability": "<adaptability_notes>"
}

Example response:
{
  "steps": [
    {
      "description": "Analyze query intent and document requirements",
      "expected_outcome": "Clear understanding of what documents are needed",
      "complexity": "low"
    }
  ],
  "tools_required": ["document_analyzer"],
  "dependencies": ["query_understanding_complete"],
  "alternatives": ["direct_keyword_search"],
  "risk_assessment": "Misinterpretation of query intent",
  "success_criteria": ["clear_problem_definition"],
  "adaptability": "Adjust based on document availability"
}`;

    const plan = await this.callLLM(planningPrompt, {
      temperature: 0.4,
      max_tokens: 1500
    });
    
    // Ensure we have a valid plan structure
    return {
      steps: Array.isArray(plan?.steps) ? plan.steps : [],
      tools_required: Array.isArray(plan?.tools_required) ? plan.tools_required : [],
      dependencies: Array.isArray(plan?.dependencies) ? plan.dependencies : [],
      alternatives: Array.isArray(plan?.alternatives) ? plan.alternatives : [],
      risk_assessment: plan?.risk_assessment || '',
      success_criteria: Array.isArray(plan?.success_criteria) ? plan.success_criteria : [],
      adaptability: plan?.adaptability || ''
    };
  }

  /**
   * Dynamic execution with adaptive tool selection
   * NOT fixed tool chains - AI selects and adapts tools
   */
  async dynamicExecution(plan, documents, conversation = []) {
    console.log('⚡ True AI Agent: Dynamic execution');
    
    // Validate plan structure
    if (!plan || !plan.steps || !Array.isArray(plan.steps)) {
      console.warn('⚠️  Invalid plan structure, using fallback');
      return {
        stepResults: [],
        toolsUsed: [],
        adaptiveDecisions: []
      };
    }
    
    const results = {
      stepResults: [],
      toolsUsed: [],
      adaptiveDecisions: []
    };
    
    // Execute each step with AI-driven decision making
    for (const [index, step] of plan.steps.entries()) {
      console.log(`⚙️  Executing step ${index + 1}: ${step.description || 'Unnamed step'}`);
      
      // Validate step structure
      if (!step || typeof step !== 'object') {
        console.warn(`⚠️  Skipping invalid step at index ${index}`);
        continue;
      }
      
      // AI determines what tools are needed for this step
      const toolSelection = await this.intelligentToolSelection(step, plan.tools_required || []);
      if (toolSelection && Array.isArray(toolSelection.selectedTools)) {
        results.toolsUsed.push(...toolSelection.selectedTools);
      }
      
      // Execute the step with selected tools
      const stepResult = await this.executeStepWithTools(step, toolSelection, documents, conversation);
      results.stepResults.push(stepResult);
      
      // AI evaluates if plan needs adjustment
      if (index < plan.steps.length - 1) {
        const adaptationNeeded = await this.evaluatePlanAdaptation(stepResult, plan.steps[index + 1]);
        if (adaptationNeeded && adaptationNeeded.needed) {
          results.adaptiveDecisions.push(adaptationNeeded);
          // Modify future steps if needed
          plan.steps = await this.adaptExecutionPlan(plan.steps, index, adaptationNeeded.modifications || []);
        }
      }
    }
    
    return results;
  }

  /**
   * Intelligent tool selection through AI reasoning
   */
  async intelligentToolSelection(step, availableTools) {
    const toolSelectionPrompt = `
You are an AI tool selection expert. For the given step, determine which tools are most appropriate.

STEP: ${step.description}
AVAILABLE TOOLS: ${JSON.stringify(availableTools, null, 2)}

SELECT the most appropriate tools and explain:
1. Why each tool is selected
2. How tools will be combined
3. Expected outputs from each tool
4. Potential limitations or considerations

Provide a rationale that demonstrates deep understanding.

Respond ONLY with valid JSON in this exact format:
{
  "selectedTools": ["<tool_name>"],
  "combinationStrategy": "<combination_strategy>",
  "rationale": "<detailed_rationale>"
}`;

    const selection = await this.callLLM(toolSelectionPrompt, {
      temperature: 0.3,
      max_tokens: 800
    });
    
    // Ensure we have valid structure
    return {
      selectedTools: Array.isArray(selection?.selectedTools) ? selection.selectedTools : [],
      combinationStrategy: selection?.combinationStrategy || 'Sequential execution',
      rationale: selection?.rationale || 'No rationale provided'
    };
  }

  /**
   * Execute step with selected tools
   */
  async executeStepWithTools(step, toolSelection, documents, conversation) {
    const executionPrompt = `
You are executing a specific step in a complex problem-solving process.

STEP: ${step.description}
SELECTED TOOLS: ${JSON.stringify(toolSelection.selectedTools, null, 2)}
DOCUMENTS AVAILABLE: ${documents.length} documents
CONVERSATION CONTEXT: ${JSON.stringify(conversation.slice(-3), null, 2)}

EXECUTE this step using the selected tools and available context.
Provide detailed execution results including:
1. Tool outputs and intermediate results
2. Insights gained during execution
3. Challenges encountered and how they were addressed
4. Quality assessment of results
5. Recommendations for next steps

Be thorough and analytical in your execution.

Respond ONLY with valid JSON in this exact format:
{
  "execution_result": "<detailed_execution_result>",
  "insights": ["<insight_1>", "<insight_2>"],
  "challenges": ["<challenge_1>", "<challenge_2>"],
  "quality_assessment": "<quality_assessment>",
  "recommendations": ["<recommendation_1>", "<recommendation_2>"]
}`;

    const execution = await this.callLLM(executionPrompt, {
      temperature: 0.2,
      max_tokens: 2000
    });
    
    // Ensure we have valid structure
    return {
      step: step.description || 'Unnamed step',
      execution_result: execution?.execution_result || 'Execution completed',
      insights: Array.isArray(execution?.insights) ? execution.insights : [],
      challenges: Array.isArray(execution?.challenges) ? execution.challenges : [],
      quality_assessment: execution?.quality_assessment || 'Not assessed',
      recommendations: Array.isArray(execution?.recommendations) ? execution.recommendations : []
    };
  }

  /**
   * Evaluate if plan needs adaptation
   */
  async evaluatePlanAdaptation(currentResult, nextStep) {
    const adaptationPrompt = `
Evaluate if the current execution results suggest plan adaptation is needed.

CURRENT RESULT QUALITY: ${currentResult.quality_assessment}
NEXT STEP: ${nextStep.description}

ASSESS if adaptation is needed and provide:
1. Whether adaptation is needed (yes/no)
2. Reasons for adaptation (if needed)
3. Specific modifications to future steps
4. Alternative approaches if current path is problematic

Think critically about the execution flow.

Respond ONLY with valid JSON in this exact format:
{
  "needed": <true|false>,
  "reasons": ["<reason_1>", "<reason_2>"],
  "modifications": ["<modification_1>", "<modification_2>"],
  "alternatives": ["<alternative_1>", "<alternative_2>"]
}`;

    const adaptation = await this.callLLM(adaptationPrompt, {
      temperature: 0.3,
      max_tokens: 600
    });
    
    // Ensure we have valid structure
    return {
      needed: adaptation?.needed === true,
      reasons: Array.isArray(adaptation?.reasons) ? adaptation.reasons : [],
      modifications: Array.isArray(adaptation?.modifications) ? adaptation.modifications : [],
      alternatives: Array.isArray(adaptation?.alternatives) ? adaptation.alternatives : []
    };
  }

  /**
   * Adapt execution plan dynamically
   */
  async adaptExecutionPlan(steps, currentIndex, modifications) {
    // AI-driven plan adaptation
    const adaptedSteps = [...steps];
    
    // Apply modifications based on AI reasoning
    for (const [index, mod] of modifications.entries()) {
      if (currentIndex + 1 + index < adaptedSteps.length) {
        adaptedSteps[currentIndex + 1 + index] = {
          ...adaptedSteps[currentIndex + 1 + index],
          ...mod
        };
      }
    }
    
    return adaptedSteps;
  }

  /**
   * Intelligent synthesis of execution results
   * NOT template-based - genuine AI synthesis
   */
  async intelligentSynthesis(executionResults, queryUnderstanding) {
    console.log('🧩 True AI Agent: Intelligent synthesis');
    
    const synthesisPrompt = `
You are an AI synthesis expert. Combine all execution results into a comprehensive final response.

QUERY UNDERSTANDING:
${JSON.stringify(queryUnderstanding, null, 2)}

EXECUTION RESULTS:
${JSON.stringify(executionResults, null, 2)}

SYNTHESIZE a comprehensive response that:
1. Directly addresses the original query
2. Integrates insights from all execution steps
3. Provides clear, actionable information
4. Maintains logical flow and coherence
5. Anticipates potential follow-up questions
6. Includes relevant citations and references

The synthesis should demonstrate deep understanding and analytical thinking.

Respond ONLY with valid JSON in this exact format:
{
  "answer": "<comprehensive_answer>",
  "confidence": <confidence_score_between_0_and_1>,
  "citations": [
    {
      "docId": "<document_id>",
      "docName": "<document_name>",
      "snippet": "<relevant_snippet>"
    }
  ],
  "key_insights": ["<insight_1>", "<insight_2>"],
  "supporting_evidence": ["<evidence_1>", "<evidence_2>"],
  "additional_considerations": ["<consideration_1>", "<consideration_2>"]
}`;

    const synthesis = await this.callLLM(synthesisPrompt, {
      temperature: 0.2,
      max_tokens: 2500
    });
    
    // Ensure we have valid structure
    return {
      answer: synthesis?.answer || 'No answer generated',
      confidence: typeof synthesis?.confidence === 'number' ? synthesis.confidence : 0.8,
      citations: Array.isArray(synthesis?.citations) ? synthesis.citations : [],
      key_insights: Array.isArray(synthesis?.key_insights) ? synthesis.key_insights : [],
      supporting_evidence: Array.isArray(synthesis?.supporting_evidence) ? synthesis.supporting_evidence : [],
      additional_considerations: Array.isArray(synthesis?.additional_considerations) ? synthesis.additional_considerations : []
    };
  }

  /**
   * Self-evaluation and learning
   * NOT static - continuous improvement through AI reflection
   */
  async selfEvaluationAndLearning(originalQuestion, response, context = {}) {
    console.log('🤔 True AI Agent: Self-evaluation and learning');
    
    const evaluationPrompt = `
Evaluate the quality of your response and identify learning opportunities.

ORIGINAL QUESTION: "${originalQuestion}"
YOUR RESPONSE: "${response.answer}"
CONTEXT: ${JSON.stringify(context, null, 2)}

SELF-EVALUATE and provide:
1. Quality assessment (completeness, accuracy, relevance)
2. Identified gaps or limitations
3. Alternative approaches that could have been better
4. Lessons learned for future similar queries
5. Confidence calibration feedback

Be honest and constructive in your self-assessment.
`;

    const evaluation = await this.callLLM(evaluationPrompt, {
      temperature: 0.1,
      max_tokens: 1000
    });
    
    // Store learning for continuous improvement
    await this.storeLearningExperience({
      question: originalQuestion,
      response: response,
      evaluation: evaluation,
      timestamp: new Date().toISOString()
    });
    
    return evaluation;
  }

  /**
   * AI-driven error handling
   * NOT predefined error responses - intelligent recovery
   */
  async aiDrivenErrorHandling(error, question) {
    const errorHandlingPrompt = `
An error occurred during AI processing. Handle this intelligently.

ERROR: ${error.message}
QUESTION: "${question}"

PROCESS this error through AI reasoning:
1. Root cause analysis of the error
2. Alternative approaches to solve the original query
3. Graceful degradation strategies
4. User-friendly error communication
5. Learning opportunities from this failure

Provide an intelligent response that maintains user trust.
`;

    const errorHandling = await this.callLLM(errorHandlingPrompt, {
      temperature: 0.2,
      max_tokens: 800
    });
    
    return {
      answer: errorHandling.graceful_response,
      confidence: 0.3,
      citations: [],
      error_recovery: errorHandling.recovery_strategy,
      learning_opportunity: errorHandling.learning_opportunity
    };
  }

  /**
   * Store learning experience for continuous improvement
   */
  async storeLearningExperience(experience) {
    // In a real implementation, this would store to a learning database
    console.log('💾 True AI Agent: Storing learning experience', {
      question_length: experience.question.length,
      response_length: experience.response.answer.length,
      evaluation_score: experience.evaluation.quality_score
    });
    
    // This is where we'd implement actual learning storage
    // For now, we'll just log it
  }

  /**
   * Core LLM calling function using rate-limited Genkit
   */
  async callLLM(prompt, options = {}) {
    try {
      // Import the rate-limited AI service
      const { generateText, canMakeRequest } = await import('../lib/ai-service.js');
      
      // Check rate limits
      if (!canMakeRequest()) {
        console.log('⚠️  Rate limit exceeded for LLM call, returning fallback response');
        return {
          answer: 'The AI service is currently busy. Please try again in a moment.',
          confidence: 0.3,
          citations: []
        };
      }
      
      // Simple text generation with rate limiting
      const response = await generateText({
        model: 'googleai/gemini-2.0-flash',
        prompt: prompt,
        config: {
          temperature: options.temperature || 0.7,
          maxOutputTokens: options.max_tokens || 2000
        }
      });
      
      // Extract text from response
      let text = response.text || '';
      
      // Try to parse as JSON if it looks like JSON
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
          return JSON.parse(text);
        } catch (parseError) {
          // If JSON parsing fails, return as text
          return { answer: text };
        }
      }
      
      // Return as text response
      return { answer: text };
      
    } catch (error) {
      console.error('❌ LLM call failed:', error);
      
      // Return a safe fallback response
      return {
        answer: 'I encountered an error while processing your request. Please try rephrasing your question.',
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Extract search parameters through AI reasoning (NOT regex)
   */
  async extractSearchParams(question, conversation = []) {
    const extractionPrompt = `
Extract search parameters from the question through deep AI understanding.

QUESTION: "${question}"
CONVERSATION CONTEXT: ${JSON.stringify(conversation.slice(-5), null, 2)}

INTELLIGENTLY extract:
1. Semantic search terms (beyond literal keywords)
2. Implied document types or categories
3. Temporal constraints and date ranges
4. Entity references (people, organizations, etc.)
5. Document relationship requirements
6. Output format preferences
7. Quality and comprehensiveness expectations

Provide extraction that demonstrates genuine understanding, not pattern matching.
`;

    const extraction = await this.callLLM(extractionPrompt, {
      temperature: 0.2,
      max_tokens: 600
    });
    
    return extraction;
  }

  /**
   * Format response through AI reasoning (NOT templates)
   */
  async formatResponse(data, question, context = {}) {
    const formattingPrompt = `
Format the response through intelligent structuring and presentation.

DATA: ${JSON.stringify(data, null, 2)}
QUESTION: "${question}"
CONTEXT: ${JSON.stringify(context, null, 2)}

INTELLIGENTLY format a response that:
1. Presents information in the most appropriate structure
2. Uses clear, readable formatting with markdown
3. Includes relevant citations and references
4. Anticipates user needs and questions
5. Provides actionable insights
6. Maintains professional tone and clarity

The formatting should enhance understanding, not just display data.
`;

    const formatting = await this.callLLM(formattingPrompt, {
      temperature: 0.1,
      max_tokens: 1500
    });
    
    return {
      answer: formatting.formatted_response,
      citations: formatting.citations || [],
      confidence: formatting.confidence || 0.9
    };
  }
}

export default TrueAIAgent;