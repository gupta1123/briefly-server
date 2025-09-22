/**
 * Fallback Service - Provides enhanced fallback mechanisms when AI services are unavailable
 */

/**
 * Enhanced fallback classification with better pattern matching
 * @param {string} question - The user's question
 * @param {Array} conversation - Conversation history
 * @returns {Object} Enhanced intent classification
 */
export function enhancedFallbackClassification(question, conversation = []) {
  const q = (question || '').toLowerCase().trim();
  
  console.log('🔄 Using enhanced fallback classification for:', q);
  
  // Enhanced pattern matching with more comprehensive rules
  const patterns = {
    // Casual conversation
    casual: [
      /\b(hi|hello|hey|what's up|whats up|howdy|how are you|how're you|how do you do|how's it going)\b/i,
      /\b(thank you|thanks|thx|thankyou|bye|goodbye|see you|later|farewell)\b/i,
      /\b(good morning|good afternoon|good evening)\b/i
    ],
    
    // Document search/find
    findFiles: [
      /\b(what.*about|tell.*about|info.*about|details.*about|metadata.*for|properties.*of|characteristics.*of)\b/i,
      /\b(title|subject|sender|receiver|date|category|type|filename|document.*type|file.*type)\b.*\b(of|for|about)\b/i,
      /\b(list|show|find|search|locate|retrieve).*\b(documents?|files?|records?|papers?|items?)\b/i,
      /\b(all|every|any).*\b(bills?|invoices?|contracts?|reports?|letters?|emails?|notices?)\b/i
    ],
    
    // Metadata queries
    metadata: [
      /\b(what.*title|what.*subject|who.*sender|who.*receiver|when.*date|what.*category|what.*type)\b/i,
      /\b(title|subject|sender|receiver|date|category|type|filename)\b/i,
      /\b(properties|details|info|information).*\b(of|about|for)\b/i
    ],
    
    // Content questions
    contentQA: [
      /\b(what.*say|what.*state|what.*mention|what.*discuss|explain|describe|summarize|what.*about.*content)\b/i,
      /\b(content|information|details|facts|data)\b.*\b(in|about|regarding)\b/i,
      /\b(can you tell me|could you explain|help me understand)\b/i
    ],
    
    // Linked documents
    linked: [
      /\b(linked|related|connected|associated|versions?|previous|next|later|earlier)\b/i,
      /\b(relations?|connections?|references?|citations?|similar)\b/i,
      /\b(see also|also see|related to|connected to)\b/i
    ],
    
    // Preview/View
    preview: [
      /\b(preview|show|view|see|look|display|render|open).*\b(document|file|content)\b/i,
      /\b(open|display|render|show me)\b/i,
      /\b(can i see|would like to see|want to view)\b/i
    ],
    
    // Timeline
    timeline: [
      /\b(timeline|chronological|over.*time|history|chronology)\b/i,
      /\b(when.*happen|sequence.*events|order.*occurred|dates|time line)\b/i,
      /\b(over time|throughout|during the period)\b/i
    ],
    
    // Data extraction
    extract: [
      /\b(extract|pull|get|gather|collect|retrieve).*\b(fields?|data|information|values?|numbers?|amounts?)\b/i,
      /\b(table|spreadsheet|csv|json|structured|format)\b/i,
      /\b(export|download|list).*\b(data|information)\b/i
    ],
    
    // Analysis
    analysis: [
      /\b(analy(z|s)e|compare|contrast|evaluate|assess|review|examine)\b/i,
      /\b(insights?|findings?|conclusions?|recommendations?|trends?|patterns?)\b/i,
      /\b(study|investigate|research)\b/i
    ],
    
    // Financial
    financial: [
      /\b(financial|invoice|bill|payment|amount|due|total|budget|expense|revenue|cost|price|fee)\b/i,
      /\b(money|dollars|rupees|payment|charge|balance)\b/i,
      /\b(account|ledger|transaction)\b/i
    ],
    
    // Legal
    legal: [
      /\b(legal|contract|agreement|law|liability|compliance|clause|section|terms|conditions)\b/i,
      /\b(court|judgment|case|statute|regulation)\b/i,
      /\b(attorney|lawyer|legal counsel)\b/i
    ],
    
    // Resume/CV
    resume: [
      /\b(resume|cv|candidate|applicant|skills?|experience|education|qualification|job|career)\b/i,
      /\b(employment|work history|professional background)\b/i,
      /\b(certification|degree|university|college)\b/i
    ]
  };
  
  // Check each pattern category
  for (const [category, regexes] of Object.entries(patterns)) {
    for (const regex of regexes) {
      if (regex.test(q)) {
        console.log(`   Matched ${category} pattern`);
        return mapCategoryToIntent(category);
      }
    }
  }
  
  // Default to content QA for general questions
  console.log('   Defaulting to ContentQA');
  return {
    intent: 'ContentQA',
    agentType: 'content',
    agentName: 'Content Agent',
    confidence: 0.5,
    needsClarification: false
  };
}

/**
 * Map pattern category to intent structure
 * @param {string} category - Pattern category
 * @returns {Object} Intent structure
 */
function mapCategoryToIntent(category) {
  const mapping = {
    casual: {
      intent: 'Casual',
      agentType: 'casual',
      agentName: 'Casual Agent',
      confidence: 0.9
    },
    findFiles: {
      intent: 'FindFiles',
      agentType: 'metadata',
      agentName: 'Metadata Agent',
      confidence: 0.8
    },
    metadata: {
      intent: 'Metadata',
      agentType: 'metadata',
      agentName: 'Metadata Agent',
      confidence: 0.7
    },
    contentQA: {
      intent: 'ContentQA',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.6
    },
    linked: {
      intent: 'Linked',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.6
    },
    preview: {
      intent: 'Preview',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.6
    },
    timeline: {
      intent: 'Timeline',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.6
    },
    extract: {
      intent: 'Extract',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.6
    },
    analysis: {
      intent: 'Analysis',
      agentType: 'content',
      agentName: 'Content Agent',
      confidence: 0.6
    },
    financial: {
      intent: 'Financial',
      agentType: 'financial',
      agentName: 'Financial Agent',
      confidence: 0.7
    },
    legal: {
      intent: 'Legal',
      agentType: 'legal',
      agentName: 'Legal Agent',
      confidence: 0.7
    },
    resume: {
      intent: 'Resume',
      agentType: 'resume',
      agentName: 'Resume Agent',
      confidence: 0.7
    }
  };
  
  return {
    ...mapping[category],
    needsClarification: false
  };
}

/**
 * Enhanced entity extraction with better regex patterns
 * @param {string} question - User question
 * @returns {Array} Extracted entities
 */
export function enhancedEntityExtraction(question) {
  const entities = [];
  const q = (question || '').trim();
  
  // Extract quoted text (potential document titles)
  const titleMatches = q.match(/["']([^"']+)[\n"']/g);
  if (titleMatches) {
    titleMatches.forEach(match => {
      entities.push({
        type: 'title',
        value: match.slice(1, -1), // Remove quotes
        confidence: 0.9
      });
    });
  }
  
  // Extract dates with more patterns
  const datePatterns = [
    /\b(\d{4}-\d{2}-\d{2})\b/, // YYYY-MM-DD
    /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/, // MM/DD/YYYY
    /\b(\d{1,2}-\d{1,2}-\d{4})\b/, // MM-DD-YYYY
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i, // Month DD, YYYY
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i, // DD Month YYYY
    /\b(last month|this month|last week|this week|yesterday|today|tomorrow)\b/i // Relative dates
  ];
  
  for (const pattern of datePatterns) {
    const dateMatch = q.match(pattern);
    if (dateMatch) {
      entities.push({
        type: 'date',
        value: dateMatch[0],
        confidence: 0.8
      });
    }
  }
  
  // Extract document types
  const docTypePatterns = {
    'Invoice': /\b(invoice|bill|receipt|payment)\b/i,
    'Contract': /\b(contract|agreement|terms|conditions)\b/i,
    'Report': /\b(report|analysis|study|review)\b/i,
    'Letter': /\b(letter|correspondence|email|memo)\b/i,
    'Resume': /\b(resume|cv|curriculum vitae)\b/i,
    'Legal': /\b(legal|court|case|judgment)\b/i
  };
  
  for (const [type, pattern] of Object.entries(docTypePatterns)) {
    if (pattern.test(q)) {
      entities.push({
        type: 'document_type',
        value: type,
        confidence: 0.7
      });
    }
  }
  
  // Extract potential names (capitalized words that might be names)
  const nameMatches = q.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g);
  if (nameMatches) {
    nameMatches.forEach(match => {
      // Simple heuristic: likely names are 2-4 words, capitalized
      if (match.length > 2 && match.length < 30 && !/^\d+$/.test(match)) {
        // Additional check: avoid common non-name words
        const commonNonNames = ['The', 'This', 'That', 'What', 'When', 'Where', 'How', 'Why', 'Who'];
        if (!commonNonNames.includes(match)) {
          entities.push({
            type: 'name',
            value: match,
            confidence: 0.6
          });
        }
      }
    });
  }
  
  // Extract organizations (keywords that suggest organizations)
  const orgKeywords = ['company', 'corporation', 'inc', 'ltd', 'llc', 'organization', 'university', 'college', 'institute'];
  const orgPattern = new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*\\s+(?:${orgKeywords.join('|')}))\\b`, 'gi');
  const orgMatches = q.match(orgPattern);
  if (orgMatches) {
    orgMatches.forEach(match => {
      entities.push({
        type: 'organization',
        value: match,
        confidence: 0.7
      });
    });
  }
  
  return entities;
}

/**
 * Fallback query expansion with synonym mapping
 * @param {string} question - Original question
 * @returns {Object} Expanded query
 */
export function fallbackQueryExpansion(question) {
  const q = (question || '').trim();
  
  // Basic synonym mapping
  const synonyms = {
    'bill': ['invoice', 'receipt', 'payment'],
    'contract': ['agreement', 'terms', 'conditions'],
    'invoice': ['bill', 'receipt', 'payment'],
    'report': ['analysis', 'study', 'review'],
    'letter': ['correspondence', 'email', 'memo'],
    'resume': ['cv', 'curriculum vitae'],
    'find': ['search', 'locate', 'retrieve'],
    'show': ['display', 'view', 'list'],
    'what': ['which', 'how'],
    'document': ['file', 'paper', 'record']
  };
  
  // Split into terms and expand
  const terms = q.split(/\s+/).filter(term => term.length > 1);
  const expandedTerms = [...terms];
  
  terms.forEach(term => {
    const lowerTerm = term.toLowerCase();
    if (synonyms[lowerTerm]) {
      expandedTerms.push(...synonyms[lowerTerm]);
    }
  });
  
  // Remove duplicates and create expanded query
  const uniqueTerms = [...new Set(expandedTerms)];
  
  return {
    original: q,
    expanded: uniqueTerms.join(' '),
    terms: uniqueTerms,
    relatedConcepts: []
  };
}

/**
 * Fallback document search when AI is unavailable
 * @param {Array} documents - Available documents
 * @param {string} question - Search question
 * @returns {Array} Filtered documents
 */
export function fallbackDocumentSearch(documents, question) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return [];
  }
  
  const q = (question || '').toLowerCase().trim();
  const terms = q.split(/\s+/).filter(term => term.length > 2);
  
  if (terms.length === 0) {
    return documents.slice(0, 10); // Return first 10 if no terms
  }
  
  // Score documents based on term matching
  const scoredDocs = documents.map(doc => {
    let score = 0;
    const docText = [
      doc.title,
      doc.filename,
      doc.subject,
      doc.sender,
      doc.receiver,
      doc.category,
      doc.type,
      (doc.description || '').substring(0, 100)
    ].filter(Boolean).join(' ').toLowerCase();
    
    terms.forEach(term => {
      if (docText.includes(term)) {
        score += 1;
      }
    });
    
    return { ...doc, score };
  });
  
  // Filter and sort by score
  return scoredDocs
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

export default {
  enhancedFallbackClassification,
  enhancedEntityExtraction,
  fallbackQueryExpansion,
  fallbackDocumentSearch
};