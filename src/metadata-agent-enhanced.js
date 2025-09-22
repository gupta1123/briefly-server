// Enhanced metadata query processing with entity awareness
async function processMetadataQuery(db, orgId, question, conversation, userMemory, routingResult, send) {
  send('stage', { agent: 'MetadataAgent', step: 'searching' });
  
  // Use extracted entities to refine search
  const entities = routingResult.entities || [];
  const expandedQuery = routingResult.expandedQuery?.expanded || question;
  
  // Build search conditions based on entities and expanded query
  let conditions = [];
  
  // Add conditions for title-related entities
  const titleEntities = entities.filter(e => e.type === 'title');
  if (titleEntities.length > 0) {
    titleEntities.forEach(entity => {
      conditions.push(`title.ilike.%${entity.value}%`);
      conditions.push(`filename.ilike.%${entity.value}%`);
    });
  }
  
  // Add conditions for document type entities
  const docTypeEntities = entities.filter(e => e.type === 'document_type');
  if (docTypeEntities.length > 0) {
    docTypeEntities.forEach(entity => {
      const typeValue = entity.value.toLowerCase();
      // Map common document type terms to actual document types
      const typeMapping = {
        'invoice': 'Invoice',
        'bill': 'Invoice',
        'receipt': 'Invoice',
        'payment': 'Invoice',
        'budget': 'Financial',
        'financial': 'Financial',
        'contract': 'Contract',
        'agreement': 'Contract',
        'legal': 'Legal',
        'resume': 'Resume',
        'cv': 'Resume',
        'report': 'Report',
        'correspondence': 'Correspondence',
        'letter': 'Correspondence',
        'email': 'Correspondence',
        'memo': 'Correspondence'
      };
      
      const mappedType = typeMapping[typeValue] || typeValue.charAt(0).toUpperCase() + typeValue.slice(1);
      conditions.push(`type.eq.${mappedType}`);
    });
  }
  
  // Add conditions for category entities
  const categoryEntities = entities.filter(e => e.type === 'category');
  if (categoryEntities.length > 0) {
    categoryEntities.forEach(entity => {
      conditions.push(`category.ilike.%${entity.value}%`);
      // Also search in subject and title for category-like terms
      conditions.push(`subject.ilike.%${entity.value}%`);
      conditions.push(`title.ilike.%${entity.value}%`);
    });
  }
  
  // Add conditions for topic entities (newly added)
  const topicEntities = entities.filter(e => e.type === 'topic');
  if (topicEntities.length > 0) {
    topicEntities.forEach(entity => {
      // Search in title, subject, and keywords for topic terms
      conditions.push(`title.ilike.%${entity.value}%`);
      conditions.push(`subject.ilike.%${entity.value}%`);
      conditions.push(`keywords.ilike.%${entity.value}%`);
    });
  }
  
  // Add conditions for date entities
  const dateEntities = entities.filter(e => e.type === 'date');
  if (dateEntities.length > 0) {
    dateEntities.forEach(entity => {
      // For date entities, we need to use proper date comparison rather than LIKE
      // Convert the entity value to a date range if it's a relative date like "last month"
      const dateValue = entity.value.toLowerCase();
      
      if (dateValue === 'last month') {
        // Get the first day of last month and last day of last month
        const now = new Date();
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const firstDay = lastMonth.toISOString().split('T')[0];
        const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
        conditions.push(`document_date.gte.${firstDay}`);
        conditions.push(`document_date.lte.${lastDay}`);
      } else if (dateValue === 'this month') {
        // Get the first day of this month and today
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const lastDay = now.toISOString().split('T')[0];
        conditions.push(`document_date.gte.${firstDay}`);
        conditions.push(`document_date.lte.${lastDay}`);
      } else if (dateValue === 'last week') {
        // Get the Monday of last week and Sunday of last week
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const mondayOfLastWeek = new Date(now);
        mondayOfLastWeek.setDate(now.getDate() - dayOfWeek - 7);
        const sundayOfLastWeek = new Date(mondayOfLastWeek);
        sundayOfLastWeek.setDate(mondayOfLastWeek.getDate() + 6);
        
        const firstDay = mondayOfLastWeek.toISOString().split('T')[0];
        const lastDay = sundayOfLastWeek.toISOString().split('T')[0];
        conditions.push(`document_date.gte.${firstDay}`);
        conditions.push(`document_date.lte.${lastDay}`);
      } else {
        // Try to parse the date value as a specific date
        try {
          const parsedDate = new Date(dateValue);
          if (!isNaN(parsedDate.getTime())) {
            // If it's a valid date, search for documents on that specific date
            const isoDate = parsedDate.toISOString().split('T')[0];
            conditions.push(`document_date.eq.${isoDate}`);
          } else {
            // For partial date matches (e.g. "2023", "january 2023"), use LIKE on the string representation
            conditions.push(`document_date::text.ilike.%${dateValue}%`);
          }
        } catch (parseError) {
          // If date parsing fails, fall back to text search
          conditions.push(`document_date::text.ilike.%${dateValue}%`);
        }
      }
    });
  }
  
  // Fallback to expanded query search
  if (conditions.length === 0) {
    const terms = expandedQuery.split(/\s+/).filter(term => term.length > 2);
    terms.forEach(term => {
      conditions.push(`title.ilike.%${term}%`);
      conditions.push(`subject.ilike.%${term}%`);
      conditions.push(`sender.ilike.%${term}%`);
      conditions.push(`receiver.ilike.%${term}%`);
      conditions.push(`category.ilike.%${term}%`);
      conditions.push(`type.ilike.%${term}%`);
      conditions.push(`keywords.ilike.%${term}%`);
    });
  }
  
  // Construct the OR query
  const orCondition = conditions.join(',');
  
  // Search for documents based on metadata
  const { data, error } = await db
    .from('documents')
    .select('id, title, filename, subject, sender, receiver, document_date, category, type, keywords')
    .eq('org_id', orgId)
    .or(orCondition)
    .order('uploaded_at', { ascending: false })
    .limit(20);
    
  if (error) throw error;
  
  if (!data || data.length === 0) {
    return {
      answer: 'I couldn\'t find any documents matching your query.',
      citations: []
    };
  }
  
  // Format the results
  const documents = data.map(doc => ({
    id: doc.id,
    title: doc.title || doc.filename || 'Untitled',
    subject: doc.subject,
    sender: doc.sender,
    receiver: doc.receiver,
    date: doc.document_date,
    category: doc.category,
    type: doc.type
  }));
  
  // Generate a natural language response
  const responseText = `I found ${documents.length} documents that match your query. Here are the key details:

${documents.slice(0, 5).map(doc => `- ${doc.title} (${doc.type}) - ${doc.category || 'Uncategorized'} - ${doc.date || 'Date unknown'}`).join('\n')}

Would you like more details about any specific document?`;
  
  // Create citations
  const citations = documents.slice(0, 3).map(doc => ({
    docId: doc.id,
    snippet: `${doc.title} (${doc.type}) - ${doc.category}`,
    docName: doc.title
  }));
  
  return {
    answer: responseText,
    citations
  };
}