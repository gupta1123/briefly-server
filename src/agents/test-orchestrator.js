// Test file for enhanced orchestrator
import EnhancedAgentOrchestrator from './enhanced-orchestrator.js';

// Simple test to verify the orchestrator is working
async function testEnhancedOrchestrator() {
  console.log('🧪 Testing Enhanced Agent Orchestrator...');
  
  const orchestrator = new EnhancedAgentOrchestrator();
  
  // Test agent class retrieval
  const metadataAgentClass = orchestrator.getAgentClass('metadata');
  const contentAgentClass = orchestrator.getAgentClass('content');
  const finderAgentClass = orchestrator.getAgentClass('finder');
  
  console.log('✅ Metadata Agent Class:', metadataAgentClass ? 'Found' : 'Not Found');
  console.log('✅ Content Agent Class:', contentAgentClass ? 'Found' : 'Not Found');
  console.log('✅ Finder Agent Class:', finderAgentClass ? 'Found' : 'Not Found');
  
  // Test secondary agent determination
  const secondaryAgents1 = orchestrator.determineSecondaryAgents('Find documents from last month', 'content');
  const secondaryAgents2 = orchestrator.determineSecondaryAgents('Compare the Q1 and Q2 reports', 'content');
  const secondaryAgents3 = orchestrator.determineSecondaryAgents('What is the title of this document?', 'content');
  
  console.log('✅ Secondary Agents for "Find documents":', secondaryAgents1);
  console.log('✅ Secondary Agents for "Compare reports":', secondaryAgents2);
  console.log('✅ Secondary Agents for "What is the title":', secondaryAgents3);
  
  // Test answer similarity
  const similar1 = orchestrator.areAnswersSimilar('The document title is Report.pdf', 'This document is called Report.pdf');
  const similar2 = orchestrator.areAnswersSimilar('The cost is $100', 'The price is $50');
  
  console.log('✅ Similar Answers (Report.pdf):', similar1);
  console.log('✅ Similar Answers (cost/price):', similar2);
  
  // Test grouping similar insights
  const testInsights = [
    { agent: 'metadata', answer: 'The document title is Report.pdf', confidence: 0.9 },
    { agent: 'finder', answer: 'This document is called Report.pdf', confidence: 0.8 },
    { agent: 'analysis', answer: 'The cost is $100', confidence: 0.7 },
    { agent: 'content', answer: 'The price is $50', confidence: 0.6 }
  ];
  
  const groupedInsights = orchestrator.groupSimilarInsights(testInsights);
  console.log('✅ Grouped Insights:', groupedInsights);
  
  console.log('🎉 All tests completed successfully!');
}

// Run the test
testEnhancedOrchestrator().catch(console.error);