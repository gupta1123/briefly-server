/**
 * Graceful Degradation Service - Ensures core functionality remains available even when AI services are degraded
 */

import { enhancedFallbackClassification, fallbackDocumentSearch } from './fallback-service.js';
import { isCircuitOpen as breakerOpen } from './retry-service.js';
import { getProviderBackoffUntil } from './ai-service.js';

/**
 * Degraded chat response generator
 * Provides basic functionality when AI services are unavailable
 * @param {Object} options - Chat options
 * @returns {Object} Degraded response
 */
export async function generateDegradedResponse(options) {
  const { 
    question, 
    documents = [], 
    conversation = [], 
    orgId,
    db 
  } = options;
  
  console.log('🤖 Using degraded response generation for question:', question);
  
  // Use fallback classification to determine intent
  const classification = enhancedFallbackClassification(question, conversation);
  
  // Generate appropriate degraded response based on intent
  switch (classification.intent) {
    case 'FindFiles':
    case 'Metadata':
      return await handleDegradedDocumentSearch({ question, documents, classification, orgId, db });
      
    case 'ContentQA':
      return await handleDegradedContentQA({ question, documents, classification });
      
    case 'Linked':
      return await handleDegradedLinkedDocs({ question, documents, classification, orgId, db });
      
    case 'Casual':
      return handleDegradedCasualChat({ question, classification });
      
    default:
      return handleDegradedDefault({ question, classification });
  }
}

/**
 * Handle degraded document search
 * @param {Object} options - Search options
 * @returns {Object} Search response
 */
async function handleDegradedDocumentSearch(options) {
  const { question, documents, classification, orgId, db } = options;
  
  // Try to search documents using fallback methods
  let searchResults = [];
  
  try {
    // First try fallback search
    searchResults = fallbackDocumentSearch(documents, question);
  } catch (error) {
    console.warn('Fallback document search failed:', error);
    
    // If that fails, try a simple database query
    try {
      const terms = question.toLowerCase().split(/\s+/).filter(term => term.length > 2);
      if (terms.length > 0) {
        const orConditions = terms.map(term => 
          `title.ilike.%${term}%,subject.ilike.%${term}%,sender.ilike.%${term}%,receiver.ilike.%${term}%`
        ).join(',');
        
        const { data } = await db
          .from('documents')
          .select('id, title, filename, subject, sender, receiver, document_date, type, category')
          .eq('org_id', orgId)
          .or(orConditions)
          .order('uploaded_at', { ascending: false })
          .limit(10);
          
        searchResults = data || [];
      }
    } catch (dbError) {
      console.error('Database search also failed:', dbError);
      searchResults = [];
    }
  }
  
  if (searchResults.length === 0) {
    return {
      answer: "I couldn't find any documents matching your query. Please try different keywords or check if you have access to the documents you're looking for.",
      citations: [],
      confidence: 0.3,
      degraded: true,
      reason: 'NO_MATCHING_DOCUMENTS'
    };
  }
  
  // Format results
  const formattedResults = searchResults.slice(0, 5).map(doc => ({
    id: doc.id,
    title: doc.title || doc.filename || 'Untitled',
    type: doc.type || 'Document',
    date: doc.document_date || 'Date unknown',
    sender: doc.sender || 'Unknown sender',
    category: doc.category || 'Uncategorized'
  }));
  
  const responseText = `### Results\n\n` +
    formattedResults.map(doc => `- ${doc.title} (${doc.type}) — ${doc.date} — ${doc.sender}`).join('\n') +
    `\n\n_Total: **${searchResults.length}** document(s)._\n\nYou can ask for more details about any specific document.`;
  
  const citations = formattedResults.map(doc => ({
    docId: doc.id,
    docName: doc.title,
    snippet: `${doc.title} (${doc.type}) - ${doc.date}`
  }));
  
  return {
    answer: responseText,
    citations,
    confidence: Math.min(0.7, 0.3 + (searchResults.length * 0.1)),
    degraded: true,
    reason: 'FALLBACK_SEARCH',
    searchResults: formattedResults
  };
}

/**
 * Handle degraded content Q&A
 * @param {Object} options - QA options
 * @returns {Object} QA response
 */
async function handleDegradedContentQA(options) {
  const { question, documents, classification } = options;
  
  // For content QA, provide information about available documents
  if (documents && documents.length > 0) {
    const sampleDocs = documents.slice(0, 3);
    const responseText = `### Content Overview\n\n` +
      sampleDocs.map(doc => (
        `- **${doc.title || doc.filename || 'Untitled'}** (${doc.type || 'Document'})\n` +
        `  - Category: ${doc.category || 'Uncategorized'}\n` +
        `  - Date: ${doc.document_date || 'Unknown'}\n` +
        `  - Sender: ${doc.sender || 'Unknown'}`
      )).join('\n') +
      '\n\nFor detailed content questions, please specify which document you\'re interested in.';
      
    const citations = sampleDocs.map(doc => ({
      docId: doc.id,
      docName: doc.title || doc.filename || 'Untitled',
      snippet: `${doc.title || doc.filename || 'Untitled'} (${doc.type || 'Document'})`
    }));
    
    return {
      answer: responseText,
      citations,
      confidence: 0.5,
      degraded: true,
      reason: 'CONTENT_QA_FALLBACK'
    };
  }
  
  return {
    answer: "I can help you with questions about document content, but I don't see any documents available right now. Please try uploading some documents first.",
    citations: [],
    confidence: 0.3,
    degraded: true,
    reason: 'NO_DOCUMENTS_AVAILABLE'
  };
}

/**
 * Handle degraded linked documents
 * @param {Object} options - Linked docs options
 * @returns {Object} Linked docs response
 */
async function handleDegradedLinkedDocs(options) {
  const { question, documents, classification, orgId, db } = options;
  
  // Try to find documents with relationships
  try {
    const { data: linkedDocs } = await db
      .from('document_links')
      .select('doc_id, linked_doc_id')
      .eq('org_id', orgId)
      .limit(20);
      
    if (linkedDocs && linkedDocs.length > 0) {
      // Get document details
      const docIds = [...new Set([
        ...linkedDocs.map(link => link.doc_id),
        ...linkedDocs.map(link => link.linked_doc_id)
      ])];
      
      const { data: docDetails } = await db
        .from('documents')
        .select('id, title, filename, type')
        .eq('org_id', orgId)
        .in('id', docIds.slice(0, 50)); // Limit to avoid performance issues
        
      if (docDetails && docDetails.length > 0) {
        const docMap = new Map(docDetails.map(doc => [doc.id, doc]));
        const linkedPairs = linkedDocs.slice(0, 5).map(link => ({
          source: docMap.get(link.doc_id),
          target: docMap.get(link.linked_doc_id)
        })).filter(pair => pair.source && pair.target);
        
        if (linkedPairs.length > 0) {
          const responseText = `### Linked Documents\n\n` +
            linkedPairs.map((pair, index) => (
              `- ${pair.source.title || pair.source.filename || 'Untitled'} → ${pair.target.title || pair.target.filename || 'Untitled'}`
            )).join('\n') +
            '\n\nThese documents appear to be related to each other.';
            
          const citations = linkedPairs.flatMap((pair, index) => [
            {
              docId: pair.source.id,
              docName: pair.source.title || pair.source.filename || 'Untitled',
              snippet: `Linked document ${index + 1} (source)`
            },
            {
              docId: pair.target.id,
              docName: pair.target.title || pair.target.filename || 'Untitled',
              snippet: `Linked document ${index + 1} (target)`
            }
          ]);
          
          return {
            answer: responseText,
            citations,
            confidence: 0.6,
            degraded: true,
            reason: 'LINKED_DOCS_FOUND'
          };
        }
      }
    }
  } catch (error) {
    console.warn('Failed to retrieve linked documents:', error);
  }
  
  return {
    answer: "I looked for linked documents but couldn't find any relationships. Linked documents are typically versions of the same document or documents that reference each other.",
    citations: [],
    confidence: 0.3,
    degraded: true,
    reason: 'NO_LINKED_DOCS_FOUND'
  };
}

/**
 * Handle degraded casual chat
 * @param {Object} options - Casual chat options
 * @returns {Object} Casual response
 */
function handleDegradedCasualChat(options) {
  const { question, classification } = options;
  
  const q = question.toLowerCase();
  
  if (/(hi|hello|hey)/.test(q)) {
    return {
      answer: "Hello! I'm your document assistant. I can help you find, organize, and understand your documents. What would you like to do today?",
      citations: [],
      confidence: 0.9,
      degraded: true,
      reason: 'CASUAL_GREETING'
    };
  }
  
  if (/(thank you|thanks|thx)/.test(q)) {
    return {
      answer: "You're welcome! I'm here to help with your document needs. Is there anything specific you'd like to know about your documents?",
      citations: [],
      confidence: 0.9,
      degraded: true,
      reason: 'CASUAL_THANKS'
    };
  }
  
  if (/(bye|goodbye|see you)/.test(q)) {
    return {
      answer: "Goodbye! Feel free to come back anytime if you need help with your documents. Have a great day!",
      citations: [],
      confidence: 0.9,
      degraded: true,
      reason: 'CASUAL_GOODBYE'
    };
  }
  
  return {
    answer: "### How I can help\n\n- Find documents\n- Answer content questions\n- Extract key fields\n- Compare or analyze docs",
    citations: [],
    confidence: 0.7,
    degraded: true,
    reason: 'CASUAL_DEFAULT'
  };
}

/**
 * Handle degraded default response
 * @param {Object} options - Default options
 * @returns {Object} Default response
 */
function handleDegradedDefault(options) {
  const { question, classification } = options;
  
  return {
    answer: "I'm currently experiencing limited functionality. Please try rephrasing your question or ask about specific documents you'd like to explore.",
    citations: [],
    confidence: 0.3,
    degraded: true,
    reason: 'DEFAULT_FALLBACK'
  };
}

/**
 * Check if AI services are degraded
 * @returns {boolean} Whether AI services are degraded
 */
export function isAIDegraded() {
  try {
    if (String(process.env.FORCE_DEGRADED_MODE || '') === '1') return true;
  } catch {}
  try {
    if (breakerOpen()) return true;
  } catch {}
  try {
    const until = getProviderBackoffUntil();
    if (typeof until === 'number' && Date.now() < until) return true;
  } catch {}
  return false;
}

/**
 * Wrap an AI function with graceful degradation
 * @param {Function} aiFunction - AI function to wrap
 * @param {Function} fallbackFunction - Fallback function
 * @returns {Function} Wrapped function
 */
export function withGracefulDegradation(aiFunction, fallbackFunction) {
  return async function(...args) {
    try {
      // Try the AI function first
      return await aiFunction(...args);
    } catch (error) {
      console.warn('AI function failed, using fallback:', error.message);
      
      // If AI fails, use fallback
      try {
        return await fallbackFunction(...args);
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError);
        
        // If both fail, return a safe degraded response
        return {
          answer: "I'm currently unable to process your request. Please try again later.",
          citations: [],
          confidence: 0.1,
          degraded: true,
          error: true
        };
      }
    }
  };
}

export default {
  generateDegradedResponse,
  isAIDegraded,
  withGracefulDegradation
};
