import BaseAgent from './base-agent.js';

/**
 * Comparison Agent - Compares documents side-by-side
 * 
 * Specializes in comparing multiple documents to highlight similarities and differences.
 */
class ComparisonAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.type = 'comparison';
  }

  /**
   * Process a document comparison request
   */
  async process(question, documents, conversation = []) {
    console.log(`🔄 Comparison Agent: Processing question "${question}"`);
    
    try {
      // Extract documents to compare
      const comparisonParams = await this.extractComparisonParams(question, documents, conversation);
      
      // Extract comparable data from documents
      const comparisonData = await this.extractComparableData(comparisonParams.documents);
      
      // Generate comparison analysis
      const analysis = await this.analyzeDifferences(comparisonData);
      
      // Format response
      const response = this.formatComparisonResponse(analysis, comparisonParams);
      
      console.log(`✅ Comparison Agent: Compared ${comparisonParams.documents.length} documents`);
      
      return {
        answer: response.answer,
        confidence: 0.9,
        citations: response.citations,
        metadata: {
          documentCount: comparisonParams.documents.length,
          comparedFields: analysis.comparedFields
        }
      };
    } catch (error) {
      console.error('❌ Comparison Agent Error:', error);
      return {
        answer: 'I encountered an error while comparing documents. Please try selecting specific documents to compare.',
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Extract comparison parameters
   */
  async extractComparisonParams(question, documents, conversation = []) {
    // Extract document references from question
    const docRefs = this.extractDocumentReferences(question, documents);
    
    // If we have specific document references, use those
    if (docRefs.length >= 2) {
      return {
        question,
        documents: docRefs,
        mode: 'specific'
      };
    }
    
    // Otherwise, use conversation context or recent documents
    const recentDocs = this.getRecentDocuments(conversation, documents);
    if (recentDocs.length >= 2) {
      return {
        question,
        documents: recentDocs.slice(0, 3), // Compare up to 3 recent docs
        mode: 'recent'
      };
    }
    
    // Fallback to first few documents
    return {
      question,
      documents: documents.slice(0, 2),
      mode: 'fallback'
    };
  }

  /**
   * Extract document references from question
   */
  extractDocumentReferences(question, documents) {
    const references = [];
    
    // Look for ordinal references (first, second, etc.)
    const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
    const numbers = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
    
    // Check conversation for document mentions
    const allText = [question, ...documents.map(d => d.title || d.filename)].join(' ').toLowerCase();
    
    // Simple matching - in practice, this would be more sophisticated
    documents.forEach((doc, index) => {
      const docTitle = (doc.title || doc.filename || '').toLowerCase();
      if (allText.includes(docTitle) || 
          allText.includes(ordinals[index]) || 
          allText.includes(numbers[index])) {
        references.push(doc);
      }
    });
    
    return references;
  }

  /**
   * Get recent documents from conversation context
   */
  getRecentDocuments(conversation, documents) {
    // Look for recently mentioned documents in conversation
    const recentMentions = new Set();
    
    // Check last few messages for document references
    const recentMessages = conversation.slice(-3);
    recentMessages.forEach(msg => {
      if (msg.content) {
        documents.forEach(doc => {
          if (msg.content.includes(doc.title || doc.filename)) {
            recentMentions.add(doc.id);
          }
        });
      }
    });
    
    // Return documents that were recently mentioned
    return documents.filter(doc => recentMentions.has(doc.id));
  }

  /**
   * Extract comparable data from documents
   */
  async extractComparableData(documents) {
    const comparisonData = [];
    
    for (const doc of documents) {
      const data = {
        id: doc.id,
        title: doc.title || doc.filename || 'Untitled',
        metadata: {
          sender: doc.sender,
          receiver: doc.receiver,
          category: doc.category,
          date: doc.document_date,
          type: doc.type
        },
        content: {
          subject: doc.subject,
          description: doc.description,
          tags: doc.tags,
          keywords: doc.keywords
        }
      };
      
      // Extract numerical data for quantitative comparison
      data.numerical = this.extractNumericalData(doc);
      
      comparisonData.push(data);
    }
    
    return comparisonData;
  }

  /**
   * Extract numerical data from document
   */
  extractNumericalData(document) {
    const numerical = {};
    
    // Extract amounts from description/subject
    const amountRegex = /(?:\\$|₹|€|£)?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|\\d+(?:\\.\\d+)?\\s*(?:dollars|usd|inr|eur|gbp)/gi;
    const amounts = (document.description || document.subject || '').match(amountRegex) || [];
    if (amounts.length > 0) {
      numerical.amounts = amounts;
    }
    
    // Extract dates
    if (document.document_date) {
      numerical.date = document.document_date;
    }
    
    // Extract version numbers from title
    const versionRegex = /v(?:ersion)?\\s*(\\d+\\.?\\d*)/i;
    const versionMatch = (document.title || '').match(versionRegex);
    if (versionMatch) {
      numerical.version = parseFloat(versionMatch[1]);
    }
    
    return numerical;
  }

  /**
   * Analyze differences between documents
   */
  async analyzeDifferences(comparisonData) {
    if (comparisonData.length < 2) {
      throw new Error('Need at least 2 documents to compare');
    }
    
    const analysis = {
      documents: comparisonData,
      comparedFields: [],
      similarities: [],
      differences: [],
      numericalComparisons: []
    };
    
    // Compare metadata fields
    const fieldsToCompare = ['sender', 'receiver', 'category', 'date', 'type'];
    fieldsToCompare.forEach(field => {
      const values = comparisonData.map(doc => doc.metadata[field]).filter(Boolean);
      if (values.length > 1) {
        const uniqueValues = [...new Set(values)];
        if (uniqueValues.length === 1) {
          analysis.similarities.push({
            field,
            value: uniqueValues[0],
            documents: comparisonData.map(d => d.title)
          });
        } else {
          analysis.differences.push({
            field,
            values: values.map((value, index) => ({
              document: comparisonData[index].title,
              value
            }))
          });
        }
        analysis.comparedFields.push(field);
      }
    });
    
    // Compare numerical data
    if (comparisonData.some(doc => Object.keys(doc.numerical || {}).length > 0)) {
      comparisonData.forEach((doc, index) => {
        if (doc.numerical) {
          Object.keys(doc.numerical).forEach(numField => {
            analysis.numericalComparisons.push({
              document: doc.title,
              field: numField,
              value: doc.numerical[numField]
            });
          });
        }
      });
    }
    
    return analysis;
  }

  /**
   * Format comparison response
   */
  formatComparisonResponse(analysis, params) {
    const docTitles = analysis.documents.map(doc => doc.title).join(', ');
    
    let response = `## Document Comparison\n\nComparing: ${docTitles}\n\n`;
    
    // Add similarities
    if (analysis.similarities.length > 0) {
      response += `### 🟢 Similarities\n`;
      analysis.similarities.forEach(sim => {
        response += `- **${sim.field}**: ${sim.value}\n`;
      });
      response += '\n';
    }
    
    // Add differences
    if (analysis.differences.length > 0) {
      response += `### 🟡 Differences\n`;
      analysis.differences.forEach(diff => {
        response += `- **${diff.field}**:\n`;
        diff.values.forEach(val => {
          response += `  - ${val.document}: ${val.value}\n`;
        });
        response += '\n';
      });
    }
    
    // Add numerical comparisons
    if (analysis.numericalComparisons.length > 0) {
      response += `### 🔢 Numerical Data\n`;
      const groupedNumerical = {};
      analysis.numericalComparisons.forEach(comp => {
        if (!groupedNumerical[comp.field]) {
          groupedNumerical[comp.field] = [];
        }
        groupedNumerical[comp.field].push(comp);
      });
      
      Object.entries(groupedNumerical).forEach(([field, comps]) => {
        response += `- **${field}**:\n`;
        comps.forEach(comp => {
          response += `  - ${comp.document}: ${comp.value}\n`;
        });
        response += '\n';
      });
    }
    
    // Add conclusion
    response += `### 📊 Summary\n`;
    response += `Analyzed ${analysis.documents.length} documents with ${analysis.comparedFields.length} common fields.\n`;
    response += `Found ${analysis.similarities.length} similarities and ${analysis.differences.length} differences.\n`;
    
    return {
      answer: response,
      citations: analysis.documents.map(doc => ({ docId: doc.id, title: doc.title }))
    };
  }
}

export default ComparisonAgent;