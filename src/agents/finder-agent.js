import BaseAgent from './base-agent.js';

/**
 * Finder Agent - Intelligent document discovery and search
 *
 * Specializes in finding documents using lightweight semantic-ish scoring on
 * fields + robust keyword matching, with filtering, sorting, and reranking.
 */
class FinderAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.type = 'finder';
  }

  /**
   * Process a document finding request
   * @param {string} question
   * @param {Array<object>} documents - Array of docs { id,title,content,metadata:{} }
   * @param {Array<object>} conversation
   */
  async process(question, documents = [], conversation = []) {
    console.log(`🔍 Finder Agent: Processing question "${question}"`);

    try {
      const searchParams = await this.extractSearchParams(question, conversation);

      // Perform hybrid search on the provided documents
      const searchResults = await this.hybridSearch(searchParams, documents);

      // Rerank results
      const rankedResults = await this.rerankResults(searchResults, searchParams);

      // Format response
      const response = this.formatResponse(rankedResults, searchParams);

      console.log(`✅ Finder Agent: Found ${rankedResults.length} documents`);

      return {
        answer: response.answer,
        confidence: Math.min(0.95, 0.7 + (rankedResults.length * 0.01)),
        citations: response.citations,
        metadata: {
          documentCount: rankedResults.length,
          searchTerms: searchParams.terms,
          filters: searchParams.filters
        }
      };
    } catch (error) {
      console.error('❌ Finder Agent Error:', error);
      return {
        answer: 'I encountered an error while searching for documents. Please try rephrasing your search.',
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Extract search parameters from the question
   */
  async extractSearchParams(question, conversation = []) {
    const entities = await this.extractEntities(question);
    const terms = this.extractSearchTerms(question);
    const filters = this.extractFilters(question, conversation);

    return {
      question,
      terms,
      entities,
      filters,
      limit: 20 // Default limit
    };
  }

  /**
   * Extract search terms from question
   */
  extractSearchTerms(question) {
    const stopWords = new Set([
      'find','show','search','look','get','give','what','where','when',
      'who','which','how','why','the','a','an','and','or','but',
      'in','on','at','to','for','of','with','by','from'
    ]);

    return this.tokenize(question)
      .filter(t => t.length > 2 && !stopWords.has(t))
      .slice(0, 10);
  }

  /**
   * Extract entities from question (lightweight NER)
   */
  async extractEntities(question) {
    const text = question || '';
    const entities = {
      dates: [],
      people: [],
      organizations: [],
      categories: []
    };

    // Dates: 2024-01-15, 15/01/2024, Jan 15 2024, etc.
    const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi;
    entities.dates = (text.match(dateRegex) || []).map(s => s.trim());

    // Emails (can help match senders/receivers)
    const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
    const emails = (text.match(emailRegex) || []).map(s => s.toLowerCase());

    // People (very naive: capitalized word pairs)
    const personRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    const people = [];
    let m;
    while ((m = personRegex.exec(text)) !== null) people.push(m[1].trim());

    // Organizations (common suffixes)
    const orgRegex = /\b([A-Z][A-Za-z0-9&.\- ]+\s(?:Inc|Corp|LLC|Ltd|Company|GmbH|PLC|University|College|School|Department|Agency))\b/g;
    const orgs = [];
    while ((m = orgRegex.exec(text)) !== null) orgs.push(m[1].trim());

    // Category hints (e.g., "category: invoices", "type legal")
    const catRegex = /\b(?:category|type)\s*[:\-]?\s*([A-Za-z0-9 _-]{3,})\b/gi;
    const cats = [];
    while ((m = catRegex.exec(text)) !== null) cats.push(m[1].trim());

    entities.people = [...new Set(people)];
    entities.organizations = [...new Set(orgs)];
    entities.categories = [...new Set(cats)];

    // Attach emails if present (useful for sender/receiver matching)
    if (emails.length) {
      entities.emails = [...new Set(emails)];
    }

    return entities;
  }

  /**
   * Extract filters from question + conversation context
   */
  extractFilters(question, conversation = []) {
    const filters = {};

    // Helpers to capture quoted or unquoted names
    const pickGroup = (re) => {
      const m = re.exec(question);
      return m ? m[1].trim().replace(/^"|"$/g, '') : undefined;
    };

    // Sender filter
    filters.sender =
      pickGroup(/(?:from|by|sender)\s+("?[\w .@-]+"?)/i) ||
      undefined;

    // Receiver filter
    filters.receiver =
      pickGroup(/(?:to|recipient|receiver)\s+("?[\w .@-]+"?)/i) ||
      undefined;

    // Category filter
    filters.category =
      pickGroup(/(?:category|type)\s+("?[\w .@-]+"?)/i) ||
      undefined;

    // Date filter (supports simple "date 2024-01-01" or "dated Jan 10 2024")
    const dateStr =
      pickGroup(/(?:date|dated)\s+("?[\w ,\/-]+"?)/i) || undefined;
    if (dateStr) filters.date = dateStr;

    // Before / after (simple)
    const after = pickGroup(/(?:after|since)\s+("?[\w ,\/-]+"?)/i);
    const before = pickGroup(/(?:before|until|till)\s+("?[\w ,\/-]+"?)/i);
    if (after) filters.after = after;
    if (before) filters.before = before;

    return filters;
  }

  /**
   * Perform hybrid search combining lightweight field scoring + keyword match
   * @param {object} searchParams
   * @param {Array<object>} documents
   * @returns {Promise<Array<object>>}
   */
  async hybridSearch(searchParams, documents) {
    console.log('🔍 Finder Agent: Performing hybrid search with params:', searchParams);

    const terms = (searchParams.terms || []).map(t => t.toLowerCase());
    const { filters = {}, entities = {} } = searchParams;

    // Pre-parse date filters
    const parseDate = (s) => {
      if (!s) return null;
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    };
    const filterDate = parseDate(filters.date);
    const filterAfter = parseDate(filters.after);
    const filterBefore = parseDate(filters.before);

    const norm = (s) => (s || '').toString().toLowerCase();
    const contains = (hay, needle) => norm(hay).includes(norm(needle));

    // Basic tokenization for scoring
    const scoreField = (text, weight = 1) => {
      if (!text || !terms.length) return 0;
      const low = norm(text);
      let score = 0;
      for (const t of terms) {
        const hits = low.split(t).length - 1;
        if (hits > 0) score += hits;
      }
      return score * weight;
    };

    // Filter + score each document
    const results = [];

    for (const doc of documents) {
      if (!doc) continue;
      const title = doc.title || '';
      const content = doc.content || '';
      const meta = doc.metadata || {};

      // --- Apply filters ---
      if (filters.sender && !contains(meta.sender, filters.sender)) continue;
      if (filters.receiver && !contains(meta.receiver, filters.receiver)) continue;
      if (filters.category && !contains(meta.category, filters.category)) continue;

      // Date filters
      const docDate = meta.date ? parseDate(meta.date) : null;
      if (filterDate && (!docDate || docDate.toDateString() !== filterDate.toDateString())) continue;
      if (filterAfter && (!docDate || docDate < filterAfter)) continue;
      if (filterBefore && (!docDate || docDate > filterBefore)) continue;

      // --- Hybrid scoring (simple & fast) ---
      let score = 0;

      // Keyword presence across fields
      score += scoreField(title, 3.5);
      score += scoreField(content, 1.5);

      // Metadata fields
      score += scoreField(meta.sender, 1.2);
      score += scoreField(meta.receiver, 1.0);
      score += scoreField(meta.category, 1.0);
      score += scoreField(meta.tags ? meta.tags.join(' ') : '', 0.8);

      // Entity boosts
      if (entities.people) {
        for (const p of entities.people) {
          if (contains(title, p) || contains(content, p) || contains(meta.sender, p) || contains(meta.receiver, p)) {
            score += 2.0;
          }
        }
      }
      if (entities.organizations) {
        for (const o of entities.organizations) {
          if (contains(title, o) || contains(content, o)) score += 1.5;
        }
      }
      if (entities.emails) {
        for (const e of entities.emails) {
          if (contains(meta.sender, e) || contains(meta.receiver, e) || contains(content, e)) score += 2.0;
        }
      }
      if (entities.categories) {
        for (const c of entities.categories) {
          if (contains(meta.category, c)) score += 1.2;
        }
      }

      // Recency boost (if doc has date)
      if (docDate instanceof Date && !isNaN(docDate.valueOf())) {
        const ageDays = (Date.now() - docDate.getTime()) / (1000 * 60 * 60 * 24);
        // Up to +1.5 for very recent, decays with age
        const recency = Math.max(0, 1.5 - Math.log1p(Math.max(0, ageDays)) / 2);
        score += recency;
      }

      // Normalize-ish similarity to [0,1] for output
      const similarity = 1 - 1 / (1 + score); // smooth increasing curve

      results.push({
        id: doc.id ?? `doc-${Math.random().toString(36).slice(2)}`,
        title: title || '(Untitled)',
        similarity,
        metadata: {
          sender: meta.sender || '',
          receiver: meta.receiver || '',
          category: meta.category || '',
          date: meta.date || '',
          tags: Array.isArray(meta.tags) ? meta.tags : []
        }
      });
    }

    return results;
  }

  /**
   * Rerank search results based on relevance & small tie-breakers
   */
  async rerankResults(results, searchParams) {
    const sorted = [...results].sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      const ad = a.metadata?.date ? new Date(a.metadata.date).getTime() : 0;
      const bd = b.metadata?.date ? new Date(b.metadata.date).getTime() : 0;
      return bd - ad; // prefer newer if similarity ties
    });
    return sorted.slice(0, searchParams.limit || 20);
  }

  /**
   * Format response for user
   */
  formatResponse(results, searchParams) {
    if (!results || results.length === 0) {
      return {
        answer: "I couldn't find any documents matching your search criteria.",
        citations: []
      };
    }

    const fmtDate = (d) => {
      if (!d) return '';
      const dt = new Date(d);
      return isNaN(dt) ? '' : dt.toISOString().slice(0, 10);
    };

    const documentList = results
      .map((doc, idx) => {
        const m = doc.metadata || {};
        const parts = [];
        if (m.sender) parts.push(`From: ${m.sender}`);
        if (m.receiver) parts.push(`To: ${m.receiver}`);
        if (m.category) parts.push(`Category: ${m.category}`);
        const d = fmtDate(m.date);
        if (d) parts.push(`Date: ${d}`);
        return `${idx + 1}. **${doc.title}**${parts.length ? ` (${parts.join(', ')})` : ''}`;
      })
      .join('\n');

    const answer =
      `I found ${results.length} document${results.length > 1 ? 's' : ''} matching your search:\n\n` +
      `${documentList}\n\n` +
      `You can ask for more details about any specific document.`;

    return {
      answer,
      citations: results.map(doc => ({ docId: doc.id, title: doc.title }))
    };
  }

  // ----------------- Helpers -----------------

  tokenize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9@._\s-]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }
}

export default FinderAgent;
