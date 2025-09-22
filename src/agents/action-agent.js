import BaseAgent from './base-agent.js';

/**
 * Action Agent - Document manipulation and workflow automation
 * 
 * Specializes in performing actions on documents like organizing, tagging, moving, etc.
 */
class ActionAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.type = 'action';
  }

  /**
   * Process an action request
   */
  async process(question, documents, conversation = []) {
    console.log(`⚡ Action Agent: Processing question "${question}"`);
    
    try {
      // Extract action parameters
      const actionParams = await this.extractActionParams(question, documents, conversation);
      
      // Validate user permissions for action
      const canPerform = await this.validatePermissions(actionParams);
      
      if (!canPerform) {
        return {
          answer: "I don't have permission to perform that action. Please contact your administrator.",
          confidence: 0.9,
          citations: [],
          metadata: {
            actionBlocked: true,
            reason: 'insufficient_permissions'
          }
        };
      }
      
      // Execute action
      const actionResults = await this.executeAction(actionParams, documents);
      
      // Format response
      const response = this.formatActionResponse(actionResults, actionParams);
      
      console.log(`✅ Action Agent: Completed action "${actionParams.actionType}"`);
      
      return {
        answer: response.answer,
        confidence: 0.95,
        citations: response.citations,
        metadata: {
          actionType: actionParams.actionType,
          actionResults: actionResults,
          documentsAffected: actionResults.affectedDocuments?.length || 0
        }
      };
    } catch (error) {
      console.error('❌ Action Agent Error:', error);
      return {
        answer: 'I encountered an error while trying to perform that action. Please try rephrasing your request.',
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Extract action parameters
   */
  async extractActionParams(question, documents, conversation = []) {
    // Determine action type from question
    const actionType = this.determineActionType(question);
    
    // Extract target documents
    const targetDocuments = this.extractTargetDocuments(question, documents, conversation);
    
    // Extract action parameters
    const actionParams = this.extractActionParameters(question, actionType);
    
    // Extract filters
    const filters = this.extractActionFilters(question);
    
    return {
      question,
      actionType,
      targetDocuments,
      actionParams,
      filters,
      requiresConfirmation: this.requiresConfirmation(actionType)
    };
  }

  /**
   * Determine action type from question
   */
  determineActionType(question) {
    const questionLower = question.toLowerCase();
    
    // Pattern matching for action types
    if (questionLower.includes('move') || questionLower.includes('relocate')) {
      return 'move_documents';
    } else if (questionLower.includes('copy') || questionLower.includes('duplicate')) {
      return 'copy_documents';
    } else if (questionLower.includes('delete') || questionLower.includes('remove') || questionLower.includes('trash')) {
      return 'delete_documents';
    } else if (questionLower.includes('tag') || questionLower.includes('label')) {
      return 'tag_documents';
    } else if (questionLower.includes('categorize') || questionLower.includes('classify')) {
      return 'categorize_documents';
    } else if (questionLower.includes('share') || questionLower.includes('send')) {
      return 'share_documents';
    } else if (questionLower.includes('rename')) {
      return 'rename_documents';
    } else if (questionLower.includes('archive')) {
      return 'archive_documents';
    } else if (questionLower.includes('organize')) {
      return 'organize_documents';
    } else if (questionLower.includes('create folder') || questionLower.includes('new folder')) {
      return 'create_folder';
    } else if (questionLower.includes('merge') || questionLower.includes('combine')) {
      return 'merge_documents';
    } else {
      return 'unknown_action'; // Default
    }
  }

  /**
   * Extract target documents from question
   */
  extractTargetDocuments(question, documents, conversation = []) {
    const targets = {
      documentIds: [],
      categories: [],
      senders: [],
      dateRanges: [],
      tags: []
    };
    
    // Extract specific document references
    const docRefs = this.extractDocumentReferences(question, documents);
    targets.documentIds.push(...docRefs);
    
    // Extract categories
    const categoryMatch = question.match(/(?:category|categories)\s+["']?([^"']+?)["']?/i);
    if (categoryMatch) {
      targets.categories.push(categoryMatch[1].trim());
    }
    
    // Extract senders
    const senderMatch = question.match(/(?:from|sender)\s+["']?([^"']+?)["']?/i);
    if (senderMatch) {
      targets.senders.push(senderMatch[1].trim());
    }
    
    // Extract date ranges
    const dateRange = this.extractDateRange(question);
    if (dateRange.start || dateRange.end) {
      targets.dateRanges.push(dateRange);
    }
    
    // Extract tags
    const tagMatch = question.match(/(?:tag|tags)\s+["']?([^"']+?)["']?/i);
    if (tagMatch) {
      targets.tags.push(tagMatch[1].trim());
    }
    
    return targets;
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
   * Extract date range
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
    
    return dateRange;
  }

  /**
   * Extract action parameters
   */
  extractActionParameters(question, actionType) {
    const params = {};
    
    switch (actionType) {
      case 'move_documents':
      case 'copy_documents':
        const destinationMatch = question.match(/(?:to|into|in)\s+["']?([^"']+?)["']?$/i);
        if (destinationMatch) {
          params.destination = destinationMatch[1].trim();
        }
        break;
        
      case 'tag_documents':
      case 'categorize_documents':
        const tagMatch = question.match(/(?:as|with)\s+["']?([^"']+?)["']?$/i);
        if (tagMatch) {
          params.tags = tagMatch[1].split(',').map(tag => tag.trim());
        }
        break;
        
      case 'rename_documents':
        const newNameMatch = question.match(/(?:to|as)\s+["']([^"']+)["']/i);
        if (newNameMatch) {
          params.newName = newNameMatch[1];
        }
        break;
        
      case 'share_documents':
        const recipientMatch = question.match(/(?:with|to)\s+["']?([^"']+?)["']?$/i);
        if (recipientMatch) {
          params.recipients = recipientMatch[1].split(',').map(r => r.trim());
        }
        break;
    }
    
    return params;
  }

  /**
   * Extract action filters
   */
  extractActionFilters(question) {
    const filters = {};
    
    // Extract limit
    const limitMatch = question.match(/(?:first|last|top)\s+(\d+)/i);
    if (limitMatch) {
      filters.limit = parseInt(limitMatch[1]);
    }
    
    // Extract sort order
    if (question.toLowerCase().includes('oldest')) {
      filters.sortBy = 'date';
      filters.sortOrder = 'asc';
    } else if (question.toLowerCase().includes('newest')) {
      filters.sortBy = 'date';
      filters.sortOrder = 'desc';
    }
    
    return filters;
  }

  /**
   * Determine if action requires confirmation
   */
  requiresConfirmation(actionType) {
    const dangerousActions = [
      'delete_documents',
      'merge_documents',
      'archive_documents'
    ];
    
    return dangerousActions.includes(actionType);
  }

  /**
   * Validate user permissions
   */
  async validatePermissions(actionParams) {
    // In a real implementation, this would check actual user permissions
    // For now, we'll assume the user has permissions for demonstration
    
    console.log('⚡ Action Agent: Validating permissions for action:', actionParams.actionType);
    
    // Mock permission validation
    const userCanPerform = true; // In practice, check actual permissions
    
    return userCanPerform;
  }

  /**
   * Execute action
   */
  async executeAction(actionParams, documents) {
    console.log('⚡ Action Agent: Executing action:', actionParams.actionType);
    
    // Filter documents based on targets
    let targetDocuments = documents;
    
    if (actionParams.targetDocuments.documentIds.length > 0) {
      targetDocuments = targetDocuments.filter(doc => 
        actionParams.targetDocuments.documentIds.includes(doc.id)
      );
    }
    
    // Apply filters
    if (actionParams.filters.sortBy) {
      targetDocuments = this.applySorting(targetDocuments, actionParams.filters);
    }
    
    if (actionParams.filters.limit) {
      targetDocuments = targetDocuments.slice(0, actionParams.filters.limit);
    }
    
    // Execute specific action
    let results;
    switch (actionParams.actionType) {
      case 'move_documents':
        results = await this.moveDocuments(targetDocuments, actionParams.actionParams);
        break;
      case 'copy_documents':
        results = await this.copyDocuments(targetDocuments, actionParams.actionParams);
        break;
      case 'delete_documents':
        results = await this.deleteDocuments(targetDocuments, actionParams.actionParams);
        break;
      case 'tag_documents':
        results = await this.tagDocuments(targetDocuments, actionParams.actionParams);
        break;
      case 'categorize_documents':
        results = await this.categorizeDocuments(targetDocuments, actionParams.actionParams);
        break;
      case 'share_documents':
        results = await this.shareDocuments(targetDocuments, actionParams.actionParams);
        break;
      case 'rename_documents':
        results = await this.renameDocuments(targetDocuments, actionParams.actionParams);
        break;
      case 'create_folder':
        results = await this.createFolder(actionParams.actionParams);
        break;
      case 'organize_documents':
        results = await this.organizeDocuments(targetDocuments, actionParams.actionParams);
        break;
      default:
        throw new Error(`Unsupported action type: ${actionParams.actionType}`);
    }
    
    return {
      ...results,
      affectedDocuments: targetDocuments.map(doc => doc.id),
      actionType: actionParams.actionType
    };
  }

  /**
   * Apply sorting to documents
   */
  applySorting(documents, filters) {
    return documents.sort((a, b) => {
      let aValue, bValue;
      
      switch (filters.sortBy) {
        case 'date':
          aValue = new Date(a.document_date || a.uploaded_at);
          bValue = new Date(b.document_date || b.uploaded_at);
          break;
        case 'title':
          aValue = (a.title || a.filename || '').toLowerCase();
          bValue = (b.title || b.filename || '').toLowerCase();
          break;
        default:
          return 0;
      }
      
      if (filters.sortOrder === 'desc') {
        return bValue > aValue ? 1 : -1;
      }
      return aValue > bValue ? 1 : -1;
    });
  }

  /**
   * Move documents
   */
  async moveDocuments(documents, params) {
    // Mock move operation
    console.log(`⚡ Action Agent: Moving ${documents.length} documents to "${params.destination}"`);
    
    return {
      success: true,
      movedCount: documents.length,
      destination: params.destination
    };
  }

  /**
   * Copy documents
   */
  async copyDocuments(documents, params) {
    // Mock copy operation
    console.log(`⚡ Action Agent: Copying ${documents.length} documents to "${params.destination}"`);
    
    return {
      success: true,
      copiedCount: documents.length,
      destination: params.destination
    };
  }

  /**
   * Delete documents
   */
  async deleteDocuments(documents, params) {
    // Mock delete operation
    console.log(`⚡ Action Agent: Deleting ${documents.length} documents`);
    
    return {
      success: true,
      deletedCount: documents.length
    };
  }

  /**
   * Tag documents
   */
  async tagDocuments(documents, params) {
    // Mock tagging operation
    console.log(`⚡ Action Agent: Tagging ${documents.length} documents with tags:`, params.tags);
    
    return {
      success: true,
      taggedCount: documents.length,
      tags: params.tags
    };
  }

  /**
   * Categorize documents
   */
  async categorizeDocuments(documents, params) {
    // Mock categorization operation
    console.log(`⚡ Action Agent: Categorizing ${documents.length} documents`);
    
    return {
      success: true,
      categorizedCount: documents.length,
      category: params.tags?.[0] // First tag as category
    };
  }

  /**
   * Share documents
   */
  async shareDocuments(documents, params) {
    // Mock sharing operation
    console.log(`⚡ Action Agent: Sharing ${documents.length} documents with:`, params.recipients);
    
    return {
      success: true,
      sharedCount: documents.length,
      recipients: params.recipients
    };
  }

  /**
   * Rename documents
   */
  async renameDocuments(documents, params) {
    // Mock renaming operation
    console.log(`⚡ Action Agent: Renaming ${documents.length} documents to "${params.newName}"`);
    
    return {
      success: true,
      renamedCount: documents.length,
      newName: params.newName
    };
  }

  /**
   * Create folder
   */
  async createFolder(params) {
    // Mock folder creation
    console.log(`⚡ Action Agent: Creating folder "${params.destination}"`);
    
    return {
      success: true,
      folderName: params.destination,
      folderId: 'new-folder-id-' + Date.now()
    };
  }

  /**
   * Organize documents
   */
  async organizeDocuments(documents, params) {
    // Mock organization operation
    console.log(`⚡ Action Agent: Organizing ${documents.length} documents`);
    
    // Simple organization by date
    const organized = {};
    documents.forEach(doc => {
      const date = doc.document_date || doc.uploaded_at;
      const month = new Date(date).toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short' 
      });
      
      if (!organized[month]) {
        organized[month] = [];
      }
      organized[month].push(doc.id);
    });
    
    return {
      success: true,
      organizedCount: documents.length,
      organizationStructure: organized
    };
  }

  /**
   * Format action response
   */
  formatActionResponse(actionResults, actionParams) {
    if (!actionResults.success) {
      return {
        answer: `❌ Action failed: ${actionResults.error || 'Unknown error'}`,
        citations: []
      };
    }
    
    let response = '';
    
    switch (actionParams.actionType) {
      case 'move_documents':
        response = `✅ Successfully moved ${actionResults.movedCount} documents to "${actionResults.destination}".`;
        break;
        
      case 'copy_documents':
        response = `✅ Successfully copied ${actionResults.copiedCount} documents to "${actionResults.destination}".`;
        break;
        
      case 'delete_documents':
        response = `🗑️ Successfully deleted ${actionResults.deletedCount} documents.`;
        break;
        
      case 'tag_documents':
        response = `🏷️ Successfully tagged ${actionResults.taggedCount} documents with: ${actionResults.tags.join(', ')}.`;
        break;
        
      case 'categorize_documents':
        response = `📁 Successfully categorized ${actionResults.categorizedCount} documents under "${actionResults.category}".`;
        break;
        
      case 'share_documents':
        response = `📤 Successfully shared ${actionResults.sharedCount} documents with: ${actionResults.recipients.join(', ')}.`;
        break;
        
      case 'rename_documents':
        response = `✏️ Successfully renamed ${actionResults.renamedCount} documents to "${actionResults.newName}".`;
        break;
        
      case 'create_folder':
        response = `📁 Successfully created folder "${actionResults.folderName}".`;
        break;
        
      case 'organize_documents':
        response = `📦 Successfully organized ${actionResults.organizedCount} documents.`;
        break;
        
      default:
        response = `✅ Action completed successfully.`;
    }
    
    // Add affected documents count
    if (actionResults.affectedDocuments && actionResults.affectedDocuments.length > 0) {
      response += `\n\nDocuments affected: ${actionResults.affectedDocuments.length}`;
    }
    
    return {
      answer: response,
      citations: actionResults.affectedDocuments 
        ? actionResults.affectedDocuments.map(id => ({ docId: id }))
        : []
    };
  }
}

export default ActionAgent;