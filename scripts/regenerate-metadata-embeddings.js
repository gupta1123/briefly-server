/**
 * Script to regenerate metadata embeddings for all existing documents
 * Usage: node scripts/regenerate-metadata-embeddings.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { generateMetadataEmbeddings } from '../src/lib/metadata-embeddings.js';

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables');
    process.exit(1);
  }
  
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  console.log('Starting metadata embeddings regeneration...');
  
  try {
    // Get all organizations
    const { data: orgs, error: orgsError } = await supabase
      .from('organizations')
      .select('id');
      
    if (orgsError) {
      console.error('Error fetching organizations:', orgsError);
      process.exit(1);
    }
    
    console.log(`Found ${orgs.length} organizations`);
    
    // Process each organization
    for (const org of orgs) {
      console.log(`Processing organization ${org.id}...`);
      
      // Get all documents for this organization
      const { data: documents, error: docsError } = await supabase
        .from('documents')
        .select('*')
        .eq('org_id', org.id);
        
      if (docsError) {
        console.error(`Error fetching documents for org ${org.id}:`, docsError);
        continue;
      }
      
      console.log(`Found ${documents.length} documents for org ${org.id}`);
      
      // Generate metadata embeddings for each document
      let successCount = 0;
      let errorCount = 0;
      
      for (const doc of documents) {
        try {
          await generateMetadataEmbeddings(supabase, org.id, doc.id, doc);
          successCount++;
          
          // Log progress every 10 documents
          if (successCount % 10 === 0) {
            console.log(`  Processed ${successCount}/${documents.length} documents for org ${org.id}`);
          }
        } catch (error) {
          console.error(`  Error processing document ${doc.id}:`, error.message);
          errorCount++;
        }
      }
      
      console.log(`Completed org ${org.id}: ${successCount} successful, ${errorCount} errors`);
    }
    
    console.log('Metadata embeddings regeneration completed!');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}