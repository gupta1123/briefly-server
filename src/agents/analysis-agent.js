import BaseAgent from './base-agent.js';

/**
 * Analysis Agent - Multi-document reasoning and insights
 * 
 * Specializes in analyzing patterns, trends, and generating insights from multiple documents.
 */
class AnalysisAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.type = 'analysis';
  }

  /**
   * Process an analysis request
   */
  async process(question, documents, conversation = []) {
    console.log(`📊 Analysis Agent: Processing question "${question}"`);
    
    try {
      // Extract analysis parameters
      const analysisParams = await this.extractAnalysisParams(question, documents, conversation);
      
      // Perform document analysis
      const analysisResults = await this.performDocumentAnalysis(analysisParams, documents);
      
      // Generate insights
      const insights = await this.generateInsights(analysisResults, analysisParams);
      
      // Format response
      const response = this.formatAnalysisResponse(insights, analysisResults, analysisParams);
      
      console.log(`✅ Analysis Agent: Completed analysis of ${documents.length} documents`);
      
      return {
        answer: response.answer,
        confidence: 0.9,
        citations: response.citations,
        metadata: {
          documentCount: documents.length,
          insightsCount: insights.length,
          analysisType: analysisParams.analysisType
        }
      };
    } catch (error) {
      console.error('❌ Analysis Agent Error:', error);
      return {
        answer: 'I encountered an error while analyzing your documents. Please try rephrasing your request.',
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Extract analysis parameters
   */
  async extractAnalysisParams(question, documents, conversation = []) {
    // Determine analysis type from question
    const analysisType = this.determineAnalysisType(question);
    
    // Extract analysis scope
    const scope = this.extractAnalysisScope(question, documents);
    
    // Extract analysis filters
    const filters = this.extractAnalysisFilters(question);
    
    // Extract specific metrics or KPIs
    const metrics = this.extractMetrics(question);
    
    return {
      question,
      analysisType,
      scope,
      filters,
      metrics,
      documents: scope.documentIds.length > 0 
        ? documents.filter(doc => scope.documentIds.includes(doc.id))
        : documents
    };
  }

  /**
   * Determine analysis type from question
   */
  determineAnalysisType(question) {
    const questionLower = question.toLowerCase();
    
    // Pattern matching for analysis types
    if (questionLower.includes('trend') || questionLower.includes('pattern')) {
      return 'trend_analysis';
    } else if (questionLower.includes('compare') || questionLower.includes('contrast')) {
      return 'comparative_analysis';
    } else if (questionLower.includes('summary') || questionLower.includes('overview')) {
      return 'summary_analysis';
    } else if (questionLower.includes('spending') || questionLower.includes('budget') || questionLower.includes('cost')) {
      return 'financial_analysis';
    } else if (questionLower.includes('risk') || questionLower.includes('compliance')) {
      return 'risk_analysis';
    } else if (questionLower.includes('frequency') || questionLower.includes('most common')) {
      return 'frequency_analysis';
    } else if (questionLower.includes('sentiment') || questionLower.includes('tone')) {
      return 'sentiment_analysis';
    } else {
      return 'general_analysis'; // Default
    }
  }

  /**
   * Extract analysis scope
   */
  extractAnalysisScope(question, documents) {
    const scope = {
      documentIds: [],
      categories: [],
      dateRange: {},
      senders: [],
      receivers: []
    };
    
    // Extract document references
    const docRefs = this.extractDocumentReferences(question, documents);
    scope.documentIds.push(...docRefs);
    
    // Extract categories
    const categoryPattern = /(?:category|type)\s+([A-Za-z]+)/gi;
    let categoryMatch;
    while ((categoryMatch = categoryPattern.exec(question)) !== null) {
      scope.categories.push(categoryMatch[1]);
    }
    
    // Extract senders/receivers
    const senderPattern = /(?:from|by|sender)\s+([A-Za-z\s]+)/gi;
    let senderMatch;
    while ((senderMatch = senderPattern.exec(question)) !== null) {
      scope.senders.push(senderMatch[1].trim());
    }
    
    const receiverPattern = /(?:to|recipient|receiver)\s+([A-Za-z\s]+)/gi;
    let receiverMatch;
    while ((receiverPattern.exec(question)) !== null) {
      scope.receivers.push(receiverMatch[1].trim());
    }
    
    return scope;
  }

  /**
   * Extract document references
   */
  extractDocumentReferences(question, documents) {
    const references = [];
    
    // Simple matching - in practice, this would be more sophisticated
    documents.forEach(doc => {
      const docIdentifier = (doc.title || doc.filename || '').toLowerCase();
      if (question.toLowerCase().includes(docIdentifier)) {
        references.push(doc.id);
      }
    });
    
    return references;
  }

  /**
   * Extract analysis filters
   */
  extractAnalysisFilters(question) {
    const filters = {};
    
    // Extract date range
    const datePattern = /(?:date|between)\s+([A-Za-z0-9\s\-\/]+)(?:\s+and\s+([A-Za-z0-9\s\-\/]+))?/gi;
    const dateMatch = datePattern.exec(question);
    if (dateMatch) {
      filters.dateRange = {
        start: dateMatch[1],
        end: dateMatch[2] || new Date().toISOString()
      };
    }
    
    return filters;
  }

  /**
   * Extract specific metrics from question
   */
  extractMetrics(question) {
    const metrics = [];
    
    // Common metrics patterns
    const metricPatterns = [
      { pattern: /(?:total|sum)\s+(\w+)/gi, type: 'sum' },
      { pattern: /(?:average|mean)\s+(\w+)/gi, type: 'average' },
      { pattern: /(?:max|min|maximum|minimum)\s+(\w+)/gi, type: 'extreme' },
      { pattern: /(\w+)\s+(?:frequency|count)/gi, type: 'count' }
    ];
    
    metricPatterns.forEach(({ pattern, type }) => {
      let match;
      while ((match = pattern.exec(question)) !== null) {
        metrics.push({
          type,
          field: match[1],
          question: question
        });
      }
    });
    
    return metrics;
  }

  /**
   * Perform document analysis
   */
  async performDocumentAnalysis(params, documents) {
    console.log('📊 Analysis Agent: Performing document analysis');
    
    // Filter documents based on scope
    let filteredDocuments = documents;
    if (params.scope.categories.length > 0) {
      filteredDocuments = filteredDocuments.filter(doc => 
        params.scope.categories.some(cat => 
          (doc.category || '').toLowerCase().includes(cat.toLowerCase())
        )
      );
    }
    
    if (params.scope.senders.length > 0) {
      filteredDocuments = filteredDocuments.filter(doc => 
        params.scope.senders.some(sender => 
          (doc.sender || '').toLowerCase().includes(sender.toLowerCase())
        )
      );
    }
    
    // Extract structured data for analysis
    const analysisData = this.extractStructuredData(filteredDocuments);
    
    // Perform specific analysis based on type
    let results;
    switch (params.analysisType) {
      case 'trend_analysis':
        results = await this.performTrendAnalysis(analysisData, params);
        break;
      case 'financial_analysis':
        results = await this.performFinancialAnalysis(analysisData, params);
        break;
      case 'frequency_analysis':
        results = await this.performFrequencyAnalysis(analysisData, params);
        break;
      case 'comparative_analysis':
        results = await this.performComparativeAnalysis(analysisData, params);
        break;
      default:
        results = await this.performGeneralAnalysis(analysisData, params);
    }
    
    return {
      ...results,
      documentCount: filteredDocuments.length,
      analysisData
    };
  }

  /**
   * Extract structured data from documents
   */
  extractStructuredData(documents) {
    const structuredData = {
      metadata: [],
      content: [],
      numerical: [],
      categorical: []
    };
    
    documents.forEach(doc => {
      // Metadata
      structuredData.metadata.push({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        sender: doc.sender,
        receiver: doc.receiver,
        date: doc.document_date,
        type: doc.type,
        fileSize: doc.file_size_bytes,
        tags: doc.tags || [],
        keywords: doc.keywords || []
      });
      
      // Content analysis
      structuredData.content.push({
        id: doc.id,
        subject: doc.subject,
        description: doc.description,
        wordCount: (doc.description || '').split(/\s+/).length
      });
      
      // Extract numerical data
      const numerical = this.extractNumericalData(doc);
      if (Object.keys(numerical).length > 0) {
        structuredData.numerical.push({
          id: doc.id,
          ...numerical
        });
      }
      
      // Categorical data
      structuredData.categorical.push({
        id: doc.id,
        category: doc.category,
        tags: doc.tags || [],
        keywords: doc.keywords || []
      });
    });
    
    return structuredData;
  }

  /**
   * Extract numerical data from document
   */
  extractNumericalData(document) {
    const numerical = {};
    
    // Extract monetary amounts
    const amountRegex = /(?:\$|₹|€|£)?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d+)?\s*(?:dollars|usd|inr|eur|gbp)/gi;
    const amounts = (document.description || document.subject || '').match(amountRegex) || [];
    if (amounts.length > 0) {
      numerical.amounts = amounts.map(amount => {
        // Extract numeric value
        const numeric = amount.replace(/[^\d\.]/g, '');
        return parseFloat(numeric) || 0;
      });
    }
    
    // Extract percentages
    const percentRegex = /(\d+(?:\.\d+)?)%/g;
    const percentages = (document.description || document.subject || '').match(percentRegex) || [];
    if (percentages.length > 0) {
      numerical.percentages = percentages.map(p => parseFloat(p));
    }
    
    // Extract dates (as timestamps)
    if (document.document_date) {
      numerical.timestamp = new Date(document.document_date).getTime();
    }
    
    return numerical;
  }

  /**
   * Perform trend analysis
   */
  async performTrendAnalysis(data, params) {
    // Mock trend analysis results
    return {
      type: 'trend_analysis',
      trends: [
        {
          metric: 'Document Volume',
          trend: 'increasing',
          percentage: 15.2,
          period: 'last_quarter'
        },
        {
          metric: 'Average Document Size',
          trend: 'stable',
          percentage: 2.1,
          period: 'last_month'
        }
      ]
    };
  }

  /**
   * Perform financial analysis
   */
  async performFinancialAnalysis(data, params) {
    // Mock financial analysis results
    return {
      type: 'financial_analysis',
      financialMetrics: {
        totalAmount: 125000,
        averageAmount: 2500,
        maxAmount: 15000,
        minAmount: 500,
        transactionCount: 50
      },
      spendingCategories: [
        { category: 'Services', amount: 75000, percentage: 60 },
        { category: 'Products', amount: 35000, percentage: 28 },
        { category: 'Miscellaneous', amount: 15000, percentage: 12 }
      ]
    };
  }

  /**
   * Perform frequency analysis
   */
  async performFrequencyAnalysis(data, params) {
    // Mock frequency analysis results
    return {
      type: 'frequency_analysis',
      frequencies: [
        { term: 'contract', count: 25, percentage: 15.2 },
        { term: 'invoice', count: 18, percentage: 10.9 },
        { term: 'agreement', count: 15, percentage: 9.1 },
        { term: 'payment', count: 12, percentage: 7.3 }
      ]
    };
  }

  /**
   * Perform comparative analysis
   */
  async performComparativeAnalysis(data, params) {
    // Mock comparative analysis results
    return {
      type: 'comparative_analysis',
      comparisons: [
        {
          category: 'Document Types',
          values: [
            { name: 'Contracts', count: 35, percentage: 45 },
            { name: 'Invoices', count: 28, percentage: 36 },
            { name: 'Reports', count: 15, percentage: 19 }
          ]
        }
      ]
    };
  }

  /**
   * Perform general analysis
   */
  async performGeneralAnalysis(data, params) {
    // Mock general analysis results
    return {
      type: 'general_analysis',
      summary: {
        totalDocuments: data.metadata.length,
        uniqueSenders: [...new Set(data.metadata.map(d => d.sender).filter(Boolean))].length,
        uniqueCategories: [...new Set(data.metadata.map(d => d.category).filter(Boolean))].length,
        averageWordCount: data.content.reduce((sum, doc) => sum + doc.wordCount, 0) / data.content.length || 0
      }
    };
  }

  /**
   * Generate insights from analysis results
   */
  async generateInsights(analysisResults, params) {
    const insights = [];
    
    // Generate insights based on analysis type
    switch (analysisResults.type) {
      case 'trend_analysis':
        insights.push(...this.generateTrendInsights(analysisResults));
        break;
      case 'financial_analysis':
        insights.push(...this.generateFinancialInsights(analysisResults));
        break;
      case 'frequency_analysis':
        insights.push(...this.generateFrequencyInsights(analysisResults));
        break;
      case 'comparative_analysis':
        insights.push(...this.generateComparativeInsights(analysisResults));
        break;
      default:
        insights.push(...this.generateGeneralInsights(analysisResults));
    }
    
    // Add actionable recommendations
    insights.push(...this.generateRecommendations(insights, params));
    
    return insights;
  }

  /**
   * Generate trend insights
   */
  generateTrendInsights(results) {
    return results.trends.map(trend => ({
      type: 'trend',
      title: `${trend.metric} ${trend.trend === 'increasing' ? '↗️' : '↘️'}`,
      description: `${trend.metric} is ${trend.trend} by ${trend.percentage.toFixed(1)}% over the ${trend.period.replace('_', ' ')}`,
      priority: trend.trend === 'increasing' ? 'high' : 'medium',
      data: trend
    }));
  }

  /**
   * Generate financial insights
   */
  generateFinancialInsights(results) {
    const insights = [];
    
    const total = results.financialMetrics.totalAmount;
    const avg = results.financialMetrics.averageAmount;
    
    insights.push({
      type: 'financial',
      title: '💰 Significant Transaction Volume',
      description: `Total transaction volume of $${total.toLocaleString()} across ${results.financialMetrics.transactionCount} transactions`,
      priority: 'high',
      data: results.financialMetrics
    });
    
    insights.push({
      type: 'financial',
      title: '📊 Average Transaction Value',
      description: `Average transaction value of $${avg.toLocaleString()} indicates ${avg > 1000 ? 'high-value' : 'moderate-value'} transactions`,
      priority: 'medium',
      data: results.financialMetrics
    });
    
    return insights;
  }

  /**
   * Generate frequency insights
   */
  generateFrequencyInsights(results) {
    const insights = [];
    
    if (results.frequencies.length > 0) {
      const topTerm = results.frequencies[0];
      
      insights.push({
        type: 'frequency',
        title: '🔥 Most Common Topic',
        description: `"${topTerm.term}" appears ${topTerm.count} times (${topTerm.percentage.toFixed(1)}%) making it the dominant topic`,
        priority: 'high',
        data: topTerm
      });
    }
    
    return insights;
  }

  /**
   * Generate comparative insights
   */
  generateComparativeInsights(results) {
    const insights = [];
    
    results.comparisons.forEach(comparison => {
      const topValue = comparison.values[0];
      
      insights.push({
        type: 'comparative',
        title: `🏆 Dominant ${comparison.category}`,
        description: `${topValue.name} represents ${topValue.percentage}% of all ${comparison.category.toLowerCase()}`,
        priority: 'high',
        data: comparison
      });
    });
    
    return insights;
  }

  /**
   * Generate general insights
   */
  generateGeneralInsights(results) {
    const insights = [];
    
    insights.push({
      type: 'general',
      title: '📚 Document Collection Overview',
      description: `Analyzed ${results.summary.totalDocuments} documents from ${results.summary.uniqueSenders} unique senders across ${results.summary.uniqueCategories} categories`,
      priority: 'medium',
      data: results.summary
    });
    
    return insights;
  }

  /**
   * Generate recommendations
   */
  generateRecommendations(insights, params) {
    const recommendations = [];
    
    // Based on insights, generate actionable recommendations
    insights.forEach(insight => {
      switch (insight.type) {
        case 'trend':
          if (insight.data.trend === 'increasing') {
            recommendations.push({
              type: 'recommendation',
              title: '📈 Scale Resources',
              description: 'Consider scaling resources to handle increasing document volume',
              priority: 'high',
              category: 'operations'
            });
          }
          break;
          
        case 'financial':
          if (insight.data.averageAmount > 5000) {
            recommendations.push({
              type: 'recommendation',
              title: '🔒 Review High-Value Transactions',
              description: 'Implement additional review processes for high-value transactions',
              priority: 'high',
              category: 'compliance'
            });
          }
          break;
          
        case 'frequency':
          recommendations.push({
            type: 'recommendation',
            title: '🏷️ Optimize Tagging',
            description: `Focus on "${insight.data.term}" as a key categorization tag`,
            priority: 'medium',
            category: 'organization'
          });
          break;
      }
    });
    
    return recommendations;
  }

  /**
   * Format analysis response
   */
  formatAnalysisResponse(insights, analysisResults, params) {
    if (insights.length === 0) {
      return {
        answer: "I completed the analysis but couldn't identify any significant insights.",
        citations: []
      };
    }
    
    let response = `## 📊 Document Analysis Report\n\n`;
    response += `**Analysis Type:** ${params.analysisType.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}\n`;
    response += `**Documents Analyzed:** ${analysisResults.documentCount}\n\n`;
    
    // Group insights by type
    const insightsByType = {};
    insights.forEach(insight => {
      if (!insightsByType[insight.type]) {
        insightsByType[insight.type] = [];
      }
      insightsByType[insight.type].push(insight);
    });
    
    // Add insights section
    response += `### 💡 Key Insights\n\n`;
    
    Object.entries(insightsByType).forEach(([type, typeInsights]) => {
      const typeName = type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
      response += `#### ${typeName}\n\n`;
      
      typeInsights.forEach(insight => {
        response += `**${insight.title}**\n`;
        response += `${insight.description}\n\n`;
      });
    });
    
    // Add data summary
    response += `### 📈 Data Summary\n`;
    response += this.formatDataSummary(analysisResults);
    
    // Add recommendations if any
    const recommendations = insights.filter(i => i.type === 'recommendation');
    if (recommendations.length > 0) {
      response += `\n### 🎯 Recommendations\n\n`;
      recommendations.forEach(rec => {
        response += `**${rec.title}**\n`;
        response += `${rec.description}\n\n`;
      });
    }
    
    return {
      answer: response,
      citations: [] // Analysis doesn't cite specific documents
    };
  }

  /**
   * Format data summary
   */
  formatDataSummary(analysisResults) {
    let summary = '';
    
    if (analysisResults.summary) {
      summary += `- Total Documents: ${analysisResults.summary.totalDocuments}\n`;
      summary += `- Unique Senders: ${analysisResults.summary.uniqueSenders}\n`;
      summary += `- Categories: ${analysisResults.summary.uniqueCategories}\n`;
      if (analysisResults.summary.averageWordCount) {
        summary += `- Avg. Word Count: ${Math.round(analysisResults.summary.averageWordCount)}\n`;
      }
    }
    
    return summary;
  }
}

export default AnalysisAgent;