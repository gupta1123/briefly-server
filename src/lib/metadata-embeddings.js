import { generateEmbedding } from '../lib/embeddings.js';

// Default metadata fields configuration
const DEFAULT_METADATA_FIELDS = [
  { field_name: 'title', field_type: 'text', is_searchable: true, is_embedded: true, weight: 1.0 },
  { field_name: 'subject', field_type: 'text', is_searchable: true, is_embedded: true, weight: 0.9 },
  { field_name: 'sender', field_type: 'text', is_searchable: true, is_embedded: true, weight: 0.8 },
  { field_name: 'receiver', field_type: 'text', is_searchable: true, is_embedded: true, weight: 0.8 },
  { field_name: 'category', field_type: 'category', is_searchable: true, is_embedded: true, weight: 0.7 },
  { field_name: 'document_date', field_type: 'date', is_searchable: true, is_embedded: false, weight: 0.6 },
  { field_name: 'tags', field_type: 'array', is_searchable: true, is_embedded: true, weight: 0.6 },
  { field_name: 'keywords', field_type: 'array', is_searchable: true, is_embedded: true, weight: 0.5 },
  { field_name: 'description', field_type: 'text', is_searchable: true, is_embedded: true, weight: 0.4 }
];

/**
 * Initialize metadata configuration for an organization
 * @param {Object} db - Supabase client
 * @param {string} orgId - Organization ID
 */
export async function initializeOrgMetadataConfig(db, orgId) {
  try {
    // Check if config already exists
    const { count } = await db.from('org_metadata_config')
      .select('*', { count: 'exact' })
      .eq('org_id', orgId);
      
    if (count > 0) {
      console.log(`Metadata config already exists for org ${orgId}`);
      return;
    }
    
    // Insert default metadata fields
    const configs = DEFAULT_METADATA_FIELDS.map(field => ({
      org_id: orgId,
      ...field
    }));
    
    const { error } = await db.from('org_metadata_config').insert(configs);
    
    if (error) {
      console.error(`Failed to initialize metadata config for org ${orgId}:`, error);
      throw error;
    }
    
    console.log(`Successfully initialized metadata config for org ${orgId}`);
  } catch (error) {
    console.error(`Error initializing metadata config for org ${orgId}:`, error);
    throw error;
  }
}

/**
 * Generate embeddings for document metadata fields
 * @param {Object} db - Supabase client (admin)
 * @param {string} orgId - Organization ID
 * @param {string} docId - Document ID
 * @param {Object} document - Document object with metadata fields
 */
export async function generateMetadataEmbeddings(db, orgId, docId, document) {
  try {
    // Get org's configured metadata fields that should be embedded
    const { data: config, error: configError } = await db.from('org_metadata_config')
      .select('*')
      .eq('org_id', orgId)
      .eq('is_embedded', true);
    
    if (configError) {
      console.error(`Failed to fetch metadata config for org ${orgId}:`, configError);
      return;
    }
    
    if (!config || config.length === 0) {
      console.log(`No metadata config found for org ${orgId}, using defaults`);
      // Use default config if none exists
      const defaultConfig = DEFAULT_METADATA_FIELDS.filter(field => field.is_embedded);
      await processMetadataFields(db, orgId, docId, document, defaultConfig);
      return;
    }
    
    await processMetadataFields(db, orgId, docId, document, config);
  } catch (error) {
    console.error(`Error generating metadata embeddings for doc ${docId}:`, error);
  }
}

/**
 * Process metadata fields and generate embeddings
 * @param {Object} db - Supabase client (admin)
 * @param {string} orgId - Organization ID
 * @param {string} docId - Document ID
 * @param {Object} document - Document object
 * @param {Array} config - Metadata configuration
 */
async function processMetadataFields(db, orgId, docId, document, config) {
  for (const fieldConfig of config) {
    const fieldValue = document[fieldConfig.field_name];
    
    if (fieldValue && shouldEmbedField(fieldConfig, fieldValue)) {
      try {
        const textValue = formatFieldValue(fieldValue, fieldConfig.field_type);
        if (textValue && textValue.length >= 3) {
          const embedding = await generateEmbedding(textValue);
          
          if (embedding) {
            const { error: upsertError } = await db.from('metadata_embeddings').upsert({
              org_id: orgId,
              doc_id: docId,
              field_type: fieldConfig.field_name,
              field_value: textValue,
              embedding: embedding,
              weight: fieldConfig.weight
            }, { onConflict: 'org_id,doc_id,field_type' });
            
            if (upsertError) {
              console.error(`Failed to upsert metadata embedding for ${fieldConfig.field_name}:`, upsertError);
            } else {
              console.log(`Generated embedding for ${fieldConfig.field_name} in doc ${docId}`);
            }
          }
        }
      } catch (error) {
        console.error(`Failed to generate embedding for ${fieldConfig.field_name}:`, error);
      }
    }
  }
}

/**
 * Determine if a field should be embedded
 * @param {Object} fieldConfig - Field configuration
 * @param {any} value - Field value
 * @returns {boolean}
 */
function shouldEmbedField(fieldConfig, value) {
  // Don't embed empty/null values
  if (!value) return false;
  
  // Don't embed very short values (likely not meaningful)
  const stringValue = String(value);
  if (stringValue.length < 3) return false;
  
  // Don't embed dates (better handled by range queries)
  if (fieldConfig.field_type === 'date') return false;
  
  return true;
}

/**
 * Format field value for embedding based on field type
 * @param {any} value - Field value
 * @param {string} fieldType - Field type
 * @returns {string}
 */
function formatFieldValue(value, fieldType) {
  if (!value) return '';
  
  switch (fieldType) {
    case 'array':
      if (Array.isArray(value)) {
        return value.filter(item => item && String(item).trim()).join(', ');
      }
      return String(value);
      
    case 'date':
      // Dates are not embedded but can be used for filtering
      return '';
      
    case 'number':
      return String(value);
      
    default:
      return String(value).trim();
  }
}

/**
 * Hybrid search combining metadata embeddings, content embeddings, and keyword search
 * @param {Object} db - Supabase client
 * @param {string} orgId - Organization ID
 * @param {string} query - Search query
 * @param {Object} options - Search options
 */
const HYBRID_CACHE = new Map();
function hk(orgId, query, options){
  return `${orgId}::${String(query||'').slice(0,500)}::${options.limit||20}::${options.threshold||0.3}`;
}

export async function hybridSearch(db, orgId, query, options = {}) {
  try {
    const key = hk(orgId, query, options);
    const cached = HYBRID_CACHE.get(key);
    if (cached && cached.exp > Date.now()) return cached.data;
    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);
    
    // 1. Metadata embedding search with intelligent filtering
    const metadataResults = await searchMetadataEmbeddings(db, orgId, queryEmbedding, options);
    
    // 2. Content embedding search (existing)
    const contentResults = await searchContentEmbeddings(db, orgId, queryEmbedding, options);
    
    // 3. Keyword search for exact matches
    const keywordResults = await searchKeywordMatches(db, orgId, query, options);
    
    // 4. Combine and rerank with weighted scoring and intelligent filtering
    const combinedResults = combineAndRerank(
      metadataResults, contentResults, keywordResults, orgId, options
    );
    
    // Final quality check: only return results with high relevance
    // Use stricter threshold of 0.5 (50%) for quality results
    const highQualityResults = combinedResults.filter(result => {
      // At least one source must have >50% similarity for the result to be meaningful
      return result.max_score >= 0.5;
    });
    
    // If we don't have any results at all, return empty array
    if (highQualityResults.length === 0) {
      console.log('🔍 No relevant results found for query:', query);
      return [];
    }
    
    console.log(`🔍 Found ${highQualityResults.length} relevant results for query:`, query);
    HYBRID_CACHE.set(key, { data: highQualityResults, exp: Date.now() + 30_000 });
    return highQualityResults;
  } catch (error) {
    console.error('Hybrid search failed:', error);
    throw error;
  }
}

/**
 * Search metadata embeddings
 * @param {Object} db - Supabase client
 * @param {string} orgId - Organization ID
 * @param {Array} queryEmbedding - Query embedding vector
 * @param {Object} options - Search options
 */
async function searchMetadataEmbeddings(db, orgId, queryEmbedding, options) {
  if (!queryEmbedding) return [];
  
  try {
    // Use stricter similarity threshold (0.4 = 40% minimum relevance for quality results)
    const similarityThreshold = options.threshold || 0.4;
    
    const { data, error } = await db.rpc('search_metadata_embeddings', {
      p_org_id: orgId,
      p_query_embedding: queryEmbedding,
      p_limit: options.limit || 20,
      p_similarity_threshold: similarityThreshold
    });
    
    if (error) {
      console.error('Metadata embedding search failed:', error);
      // Even if database function fails, try to return some results with basic filtering
      return [];
    }
    
    // Filter results to only include highly relevant matches
    const filteredResults = (data || []).filter(result => {
      const similarity = parseFloat(result.similarity) || 0;
      // Only include results with high similarity (>50%)
      // This ensures only the most relevant results are returned
      return similarity >= Math.max(similarityThreshold, 0.5);
    });
    
    return filteredResults;
  } catch (error) {
    console.error('Metadata embedding search error:', error);
    // Return empty array on error
    return [];
  }
}

/**
 * Search content embeddings (existing functionality)
 * @param {Object} db - Supabase client
 * @param {string} orgId - Organization ID
 * @param {Array} queryEmbedding - Query embedding vector
 * @param {Object} options - Search options
 */
async function searchContentEmbeddings(db, orgId, queryEmbedding, options) {
  if (!queryEmbedding) return [];
  
  try {
    // Use intelligent similarity threshold (0.4 = 40% minimum relevance)
    const similarityThreshold = options.threshold || 0.4;
    
    const { data, error } = await db.rpc('match_doc_chunks', {
      p_org_id: orgId,
      p_query_embedding: queryEmbedding,
      p_match_count: options.limit || 20,
      p_similarity_threshold: similarityThreshold
    });
    
    if (error) {
      console.error('Content embedding search failed:', error);
      return [];
    }
    
    // Filter results to only include reasonably relevant matches
    const filteredResults = (data || []).filter(result => {
      const similarity = parseFloat(result.similarity) || 0;
      // Only include results with meaningful similarity (>40%)
      return similarity >= similarityThreshold;
    });
    
    return filteredResults;
  } catch (error) {
    console.error('Content embedding search error:', error);
    return [];
  }
}

/**
 * Keyword search on document metadata
 * @param {Object} db - Supabase client
 * @param {string} orgId - Organization ID
 * @param {string} query - Search query
 * @param {Object} options - Search options
 */
async function searchKeywordMatches(db, orgId, query, options) {
  try {
    const raw = String(query || '').trim();
    // Sanitize to avoid breaking PostgREST or() parser (commas/parentheses split filters)
    const safe = raw.replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
    const searchTerm = `%${safe}%`;
    const { data, error } = await db
      .from('documents')
      .select('id, title, subject, sender, receiver, category, description, uploaded_at, type')
      .eq('org_id', orgId)
      .neq('type', 'folder')  // Exclude folders from search results
      .or(`title.ilike.${searchTerm},subject.ilike.${searchTerm},sender.ilike.${searchTerm},receiver.ilike.${searchTerm},category.ilike.${searchTerm},description.ilike.${searchTerm}`)
      .order('uploaded_at', { ascending: false })
      .limit(options.limit || 20);
    
    if (error) {
      console.error('Keyword search failed:', error);
      return [];
    }
    
    // Calculate relevance scores based on match quality
    return (data || []).map(doc => {
      // Calculate a relevance score based on how well the query matches
      const titleMatch = doc.title && doc.title.toLowerCase().includes(query.toLowerCase()) ? 1.0 : 0;
      const subjectMatch = doc.subject && doc.subject.toLowerCase().includes(query.toLowerCase()) ? 0.8 : 0;
      const categoryMatch = doc.category && doc.category.toLowerCase().includes(query.toLowerCase()) ? 0.7 : 0;
      const senderMatch = doc.sender && doc.sender.toLowerCase().includes(query.toLowerCase()) ? 0.6 : 0;
      const receiverMatch = doc.receiver && doc.receiver.toLowerCase().includes(query.toLowerCase()) ? 0.6 : 0;
      const descriptionMatch = doc.description && doc.description.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0;
      
      // Base similarity score from keyword matches (0.2-1.0 range for more inclusive filtering)\n      const similarity = Math.max(0.2, titleMatch, subjectMatch, categoryMatch, senderMatch, receiverMatch, descriptionMatch);
      
      return {
        doc_id: doc.id,
        title: doc.title,
        type: doc.type,
        uploaded_at: doc.uploaded_at,
        similarity: similarity,
        source: 'keyword'
      };
    }).filter(doc => doc.similarity >= 0.2); // Lowered threshold to 20% for more inclusive keyword matches
  } catch (error) {
    console.error('Keyword search error:', error);
    return [];
  }
}

/**
 * Combine and rerank search results from different sources with intelligent filtering
 * @param {Array} metadataResults - Metadata embedding search results
 * @param {Array} contentResults - Content embedding search results
 * @param {Array} keywordResults - Keyword search results
 * @param {string} orgId - Organization ID
 * @param {Object} options - Search options
 * @returns {Array} Combined and reranked results
 */
function combineAndRerank(metadataResults, contentResults, keywordResults, orgId, options = {}) {
  // Create a map to store unique documents with their scores
  const docScores = new Map();
  
  // Process metadata results (highest weight since it's semantic)\n  metadataResults.forEach(result => {\n    const baseScore = (result.similarity || 0);\n    const weight = (result.weight || 1.0);\n    const score = baseScore * weight;\n    \n    // Only process results with meaningful similarity\n    if (score >= 0.2) { // Lowered threshold to 20% for better inclusivity\n      const existing = docScores.get(result.doc_id) || { score: 0, sources: [], maxScore: 0 };\n      const newMaxScore = Math.max(existing.maxScore, baseScore);\n      docScores.set(result.doc_id, {\n        ...existing,\n        score: Math.max(existing.score, score),\n        maxScore: newMaxScore,\n        sources: [...existing.sources, { \n          type: 'metadata', \n          field: result.field_type, \n          similarity: result.similarity,\n          weight: weight\n        }]\n      });\n    }\n  });
  
  // Process content results
  contentResults.forEach(result => {
    const score = result.similarity || 0;
    
    // Only process results with meaningful similarity
    if (score >= 0.2) { // Lowered threshold to 20% for better inclusivity
      const existing = docScores.get(result.doc_id) || { score: 0, sources: [], maxScore: 0 };
      const newMaxScore = Math.max(existing.maxScore, score);
      docScores.set(result.doc_id, {
        ...existing,
        score: Math.max(existing.score, score * 0.9), // Slightly lower weight than metadata
        maxScore: newMaxScore,
        sources: [...existing.sources, { 
          type: 'content', 
          similarity: result.similarity,
          weight: result.weight || 0.8
        }]
      });
    }
  });
  
  // Process keyword results
  keywordResults.forEach(result => {
    const score = result.similarity || 0.6; // Higher base score for keyword matches
    
    // Only process results with reasonable keyword match strength
    if (score >= 0.5) { // Increased threshold to 50% for keywords
      const existing = docScores.get(result.doc_id) || { score: 0, sources: [], maxScore: 0 };
      const newMaxScore = Math.max(existing.maxScore, score);
      docScores.set(result.doc_id, {
        ...existing,
        score: Math.max(existing.score, score * 0.7), // Lower weight than metadata/content
        maxScore: newMaxScore,
        sources: [...existing.sources, { type: 'keyword', similarity: result.similarity }]
      });
    }
  });
  
  // Convert to array and apply final filtering
  let combined = Array.from(docScores.entries())
    .map(([docId, data]) => ({
      doc_id: docId,
      score: data.score,
      max_score: data.maxScore, // Highest individual source score
      sources: data.sources
    }))
    // Filter to only include documents with meaningful relevance
    .filter(item => item.max_score >= 0.2) // Lowered threshold to 20% for better inclusivity
    // Sort by composite score descending
    .sort((a, b) => b.score - a.score)
    // Limit results to prevent overwhelming and maintain quality
    .slice(0, Math.min(options.limit || 20, 20)); // Increased limit to 20 for better coverage
  
  return combined;
}
