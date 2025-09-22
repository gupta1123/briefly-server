import BaseAgent from './base-agent.js';

/**
 * Timeline Agent - Temporal analysis of documents
 * 
 * Specializes in showing document flows and relationships over time.
 */
class TimelineAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.type = 'timeline';
  }

  /**
   * Process a timeline request
   */
  async process(question, documents, conversation = []) {
    console.log(`📅 Timeline Agent: Processing question "${question}"`);
    
    try {
      // Extract timeline parameters
      const timelineParams = await this.extractTimelineParams(question, documents, conversation);
      
      // Generate timeline data
      const timelineData = await this.generateTimeline(timelineParams);
      
      // Format response
      const response = this.formatTimelineResponse(timelineData, timelineParams);
      
      console.log(`✅ Timeline Agent: Generated timeline with ${timelineData.events.length} events`);
      
      return {
        answer: response.answer,
        confidence: 0.85,
        citations: response.citations,
        metadata: {
          eventCount: timelineData.events.length,
          dateRange: timelineData.dateRange,
          entities: timelineData.entities
        }
      };
    } catch (error) {
      console.error('❌ Timeline Agent Error:', error);
      return {
        answer: 'I encountered an error while generating the timeline. Please try rephrasing your request.',
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Extract timeline parameters
   */
  async extractTimelineParams(question, documents, conversation = []) {
    // Extract entities (people, organizations, topics)
    const entities = await this.extractTimelineEntities(question, documents);
    
    // Extract date range
    const dateRange = this.extractDateRange(question);
    
    // Extract filters from question
    const filters = this.extractTimelineFilters(question);
    
    return {
      question,
      entities,
      dateRange,
      filters,
      sortBy: filters.sortBy || 'date',
      sortOrder: filters.sortOrder || 'asc'
    };
  }

  /**
   * Extract entities for timeline analysis
   */
  async extractTimelineEntities(question, documents) {
    const entities = {
      people: [],
      organizations: [],
      topics: [],
      documentTypes: []
    };
    
    // Extract entities from question
    const questionEntities = await this.extractNamedEntities(question);
    entities.people.push(...questionEntities.people);
    entities.organizations.push(...questionEntities.organizations);
    entities.topics.push(...questionEntities.topics);
    
    // Extract entities from documents
    const docEntities = this.extractEntitiesFromDocuments(documents);
    entities.people.push(...docEntities.people);
    entities.organizations.push(...docEntities.organizations);
    
    // Remove duplicates
    entities.people = [...new Set(entities.people)];
    entities.organizations = [...new Set(entities.organizations)];
    entities.topics = [...new Set(entities.topics)];
    entities.documentTypes = [...new Set(entities.documentTypes)];
    
    return entities;
  }

  /**
   * Extract named entities from text
   */
  async extractNamedEntities(text) {
    // Simple regex-based extraction - in practice, would use NER models
    const entities = {
      people: [],
      organizations: [],
      topics: [],
      locations: []
    };
    
    // Common organization suffixes
    const orgSuffixes = ['Inc', 'Corp', 'LLC', 'Ltd', 'Company', 'Corporation', 
                         'University', 'College', 'School', 'Agency', 'Department',
                         'Ministry', 'Bank', 'Fund', 'Association', 'Foundation'];
    
    // Extract potential organizations
    const orgPattern = new RegExp(`[A-Z][a-z]+\\s+(?:${orgSuffixes.join('|')})`, 'gi');
    const orgMatches = text.match(orgPattern) || [];
    entities.organizations.push(...orgMatches);
    
    // Extract potential people (First Last pattern)
    const personPattern = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g;
    const personMatches = text.match(personPattern) || [];
    entities.people.push(...personMatches);
    
    // Extract topics (important keywords)
    const topicKeywords = ['contract', 'agreement', 'invoice', 'bill', 'report', 
                           'proposal', 'meeting', 'discussion', 'review', 'analysis'];
    const topicPattern = new RegExp(`\b(${topicKeywords.join('|')})\b`, 'gi');
    const topicMatches = text.match(topicPattern) || [];
    entities.topics.push(...topicMatches.map(t => t.toLowerCase()));
    
    return entities;
  }

  /**
   * Extract entities from documents
   */
  extractEntitiesFromDocuments(documents) {
    const entities = {
      people: [],
      organizations: [],
      topics: [],
      documentTypes: []
    };
    
    documents.forEach(doc => {
      // Extract from document metadata
      if (doc.sender) entities.people.push(doc.sender);
      if (doc.receiver) entities.people.push(doc.receiver);
      if (doc.category) entities.topics.push(doc.category);
      if (doc.type) entities.documentTypes.push(doc.type);
      
      // Extract from tags/keywords
      if (Array.isArray(doc.tags)) {
        entities.topics.push(...doc.tags);
      }
      if (Array.isArray(doc.keywords)) {
        entities.topics.push(...doc.keywords);
      }
    });
    
    return entities;
  }

  /**
   * Extract date range from question
   */
  extractDateRange(question) {
    const dateRange = {
      start: null,
      end: null
    };
    
    // Extract date patterns
    const dateRegex = /\b(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi;
    const dateMatches = [...question.matchAll(dateRegex)];
    
    if (dateMatches.length > 0) {
      const dates = dateMatches.map(match => new Date(match[0]));
      dates.sort((a, b) => a - b);
      
      dateRange.start = dates[0];
      dateRange.end = dates[dates.length - 1];
    }
    
    // Handle relative dates (last month, last year, etc.)
    if (question.toLowerCase().includes('last month')) {
      const now = new Date();
      dateRange.end = new Date(now.getFullYear(), now.getMonth(), 0);
      dateRange.start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    } else if (question.toLowerCase().includes('last year')) {
      const now = new Date();
      dateRange.end = new Date(now.getFullYear() - 1, 11, 31);
      dateRange.start = new Date(now.getFullYear() - 1, 0, 1);
    } else if (question.toLowerCase().includes('this year')) {
      const now = new Date();
      dateRange.start = new Date(now.getFullYear(), 0, 1);
      dateRange.end = now;
    }
    
    return dateRange;
  }

  /**
   * Extract timeline filters from question
   */
  extractTimelineFilters(question) {
    const filters = {};
    
    // Extract sort preferences
    if (question.toLowerCase().includes('chronological')) {
      filters.sortBy = 'date';
      filters.sortOrder = 'asc';
    } else if (question.toLowerCase().includes('reverse')) {
      filters.sortBy = 'date';
      filters.sortOrder = 'desc';
    }
    
    // Extract document type filters
    const docTypes = ['invoice', 'contract', 'email', 'report', 'letter'];
    docTypes.forEach(type => {
      if (question.toLowerCase().includes(type)) {
        filters.documentType = type;
      }
    });
    
    return filters;
  }

  /**
   * Generate timeline data
   */
  async generateTimeline(params) {
    // This would integrate with your database to fetch timeline data
    console.log('📅 Timeline Agent: Generating timeline with params:', params);
    
    // Mock timeline data for demonstration
    const timelineData = {
      events: [
        {
          id: 'event-1',
          date: new Date('2024-01-15'),
          title: 'Initial Contract Discussion',
          description: 'Meeting between ABC Corp and XYZ Ltd regarding service agreement',
          type: 'meeting',
          participants: ['John Smith', 'Jane Doe'],
          documentId: 'doc-1',
          category: 'Legal'
        },
        {
          id: 'event-2',
          date: new Date('2024-01-20'),
          title: 'Draft Contract Sent',
          description: 'First draft of service agreement sent for review',
          type: 'document',
          participants: ['John Smith', 'Jane Doe'],
          documentId: 'doc-2',
          category: 'Legal'
        },
        {
          id: 'event-3',
          date: new Date('2024-02-01'),
          title: 'Contract Feedback Received',
          description: 'Feedback and revision requests from legal team',
          type: 'email',
          participants: ['Legal Team', 'John Smith'],
          documentId: 'doc-3',
          category: 'Legal'
        },
        {
          id: 'event-4',
          date: new Date('2024-02-15'),
          title: 'Final Contract Signed',
          description: 'Contract officially signed by both parties',
          type: 'document',
          participants: ['John Smith', 'Jane Doe'],
          documentId: 'doc-4',
          category: 'Legal'
        }
      ],
      dateRange: {
        start: new Date('2024-01-15'),
        end: new Date('2024-02-15')
      },
      entities: {
        people: ['John Smith', 'Jane Doe', 'Legal Team'],
        organizations: ['ABC Corp', 'XYZ Ltd'],
        topics: ['Legal', 'Contract']
      }
    };
    
    // Apply filters
    if (params.filters.documentType) {
      timelineData.events = timelineData.events.filter(event => 
        event.category.toLowerCase().includes(params.filters.documentType.toLowerCase())
      );
    }
    
    // Sort events
    timelineData.events.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      
      if (params.sortOrder === 'desc') {
        return dateB - dateA;
      }
      return dateA - dateB;
    });
    
    return timelineData;
  }

  /**
   * Format timeline response
   */
  formatTimelineResponse(timelineData, params) {
    if (timelineData.events.length === 0) {
      return {
        answer: "I couldn't find any timeline events matching your criteria.",
        citations: []
      };
    }
    
    let response = `## 📅 Timeline View\n\n`;
    response += `**Date Range:** ${this.formatDateRange(timelineData.dateRange)}\n`;
    response += `**Events Found:** ${timelineData.events.length}\n\n`;
    
    // Add entities involved
    if (timelineData.entities.people.length > 0) {
      response += `**👥 People Involved:** ${timelineData.entities.people.join(', ')}\n`;
    }
    if (timelineData.entities.organizations.length > 0) {
      response += `**🏢 Organizations:** ${timelineData.entities.organizations.join(', ')}\n`;
    }
    response += '\n';
    
    // Format timeline events
    timelineData.events.forEach(event => {
      response += `### ${this.formatDate(event.date)} - ${event.title}\n`;
      response += `**Type:** ${event.type.charAt(0).toUpperCase() + event.type.slice(1)}\n`;
      response += `**Participants:** ${event.participants.join(', ')}\n`;
      if (event.description) {
        response += `**Description:** ${event.description}\n`;
      }
      response += '\n';
    });
    
    // Add summary
    response += `### 📊 Summary\n`;
    response += `This timeline shows ${timelineData.events.length} key events over a period of `;
    const duration = Math.ceil((timelineData.dateRange.end - timelineData.dateRange.start) / (1000 * 60 * 60 * 24));
    response += `${duration} days involving ${timelineData.entities.people.length} people and ${timelineData.entities.organizations.length} organizations.\n`;
    
    return {
      answer: response,
      citations: timelineData.events
        .filter(event => event.documentId)
        .map(event => ({ docId: event.documentId, title: event.title }))
    };
  }

  /**
   * Format date range
   */
  formatDateRange(dateRange) {
    if (!dateRange.start || !dateRange.end) return 'Unknown';
    
    const startStr = this.formatDate(dateRange.start);
    const endStr = this.formatDate(dateRange.end);
    
    return `${startStr} to ${endStr}`;
  }

  /**
   * Format date for display
   */
  formatDate(date) {
    if (!(date instanceof Date)) {
      date = new Date(date);
    }
    
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
}

export default TimelineAgent;