#!/usr/bin/env node

/**
 * Script to regenerate embeddings for documents that are missing them
 * Usage: node scripts/regenerate-embeddings.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { ai } from '../src/ai.js';

// Load environment variables
dotenv.config();

// Validate environment
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

if (!openaiApiKey) {
  console.error('Missing OpenAI API key - please set OPENAI_API_KEY in your environment');
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function embedChunks(chunks) {
  if (!openaiApiKey) return null;
  
  // OpenAI embeddings API expects an array of strings. Map chunk objects to their content.
  const inputs = Array.isArray(chunks)
    ? chunks.map((c) => (typeof c === 'string' ? c : (c && typeof c.content === 'string' ? c.content : '')))
    : [];
    
  console.log(`Generating embeddings for ${inputs.length} chunks...`);
  
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${openaiApiKey}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: inputs }),
  });
  
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI embed failed: ${res.status} ${txt}`);
  }
  
  const data = await res.json();
  const out = data?.data?.map((d) => d.embedding) || null;
  return out;
}

async function getDocumentExtraction(orgId, docId) {
  try {
    const key = `${orgId}/${docId}.json`;
    const { data, error } = await supabase.storage.from('extractions').download(key);
    
    if (error) {
      console.error(`Error downloading extraction for ${docId}:`, error);
      return null;
    }
    
    const jsonStr = await data.text();
    const extraction = JSON.parse(jsonStr);
    return extraction;
  } catch (error) {
    console.error(`Error parsing extraction for ${docId}:`, error);
    return null;
  }
}

function chunkText(text) {
  const target = 1200; // chars
  const overlap = 200;
  const words = text.split(/\s+/);
  const chunks = [];
  let buf = [];
  let len = 0;
  
  for (const w of words) {
    const wlen = w.length + 1;
    if (len + wlen > target && buf.length > 0) {
      chunks.push(buf.join(' '));
      // overlap
      const back = [];
      let backLen = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        const l = buf[i].length + 1;
        if (backLen + l > overlap) break;
        back.unshift(buf[i]);
        backLen += l;
      }
      buf = back;
      len = back.join(' ').length;
    }
    buf.push(w);
    len += wlen;
  }
  if (buf.length) chunks.push(buf.join(' '));
  return chunks;
}

function chunkTextByPages(pages) {
  // pages: array of { page?: number, text: string }
  const out = [];
  let idx = 0;
  for (const p of pages) {
    const pageNum = typeof p.page === 'number' ? p.page : (idx + 1);
    const parts = chunkText(String(p.text || ''));
    for (const part of parts) out.push({ content: part, page: pageNum });
    idx++;
  }
  return out;
}

async function regenerateEmbeddingsForDocument(orgId, docId) {
  console.log(`\nProcessing document ${docId}...`);
  
  try {
    // Get document extraction data
    const extraction = await getDocumentExtraction(orgId, docId);
    if (!extraction) {
      console.log(`  No extraction data found for document ${docId}`);
      return;
    }
    
    const { ocrText, ocrPages } = extraction;
    const text = String(ocrText || '').trim();
    
    if (!text) {
      console.log(`  No OCR text found for document ${docId}`);
      return;
    }
    
    // Build chunks, preserving page numbers when available
    const chunks = ocrPages && ocrPages.length > 0
      ? chunkTextByPages(ocrPages)
      : chunkText(text).map((c, i) => ({ content: c, page: null }));
      
    if (chunks.length === 0) {
      console.log(`  No chunks generated for document ${docId}`);
      return;
    }
    
    console.log(`  Generated ${chunks.length} chunks`);
    
    // Generate embeddings
    const embeddings = await embedChunks(chunks);
    if (!embeddings) {
      console.log(`  Failed to generate embeddings for document ${docId}`);
      return;
    }
    
    console.log(`  Generated ${embeddings.length} embeddings`);
    
    // Remove prior chunks for this doc
    const { error: deleteError } = await supabase
      .from('doc_chunks')
      .delete()
      .eq('org_id', orgId)
      .eq('doc_id', docId);
      
    if (deleteError) {
      console.error(`  Error deleting old chunks for ${docId}:`, deleteError);
      return;
    }
    
    // Insert new chunks with embeddings
    const rows = chunks.map((c, i) => ({ 
      org_id: orgId, 
      doc_id: docId, 
      chunk_index: i, 
      content: c.content, 
      page: c.page ?? null, 
      embedding: embeddings?.[i] || null 
    }));
    
    // Insert in batches
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const slice = rows.slice(i, i + batchSize);
      const { error: insertError } = await supabase
        .from('doc_chunks')
        .insert(slice);
        
      if (insertError) {
        console.error(`  Error inserting chunks for ${docId}:`, insertError);
        return;
      }
    }
    
    console.log(`  ✅ Successfully regenerated embeddings for document ${docId}`);
  } catch (error) {
    console.error(`  ❌ Error processing document ${docId}:`, error);
  }
}

async function main() {
  console.log('🚀 Starting embedding regeneration script...');
  
  try {
    // Get all organizations
    const { data: orgs, error: orgError } = await supabase
      .from('organizations')
      .select('id');
      
    if (orgError) {
      console.error('Error fetching organizations:', orgError);
      process.exit(1);
    }
    
    console.log(`Found ${orgs.length} organizations`);
    
    // Process each organization
    for (const org of orgs) {
      const orgId = org.id;
      console.log(`\nProcessing organization ${orgId}...`);
      
      // Find documents in this org that have chunks but no embeddings
      const { data: docs, error: docError } = await supabase
        .rpc('get_docs_missing_embeddings', { p_org_id: orgId });
        
      if (docError) {
        console.error(`Error fetching documents for org ${orgId}:`, docError);
        continue;
      }
      
      console.log(`  Found ${docs.length} documents missing embeddings`);
      
      // Process each document
      for (const doc of docs) {
        await regenerateEmbeddingsForDocument(orgId, doc.id);
      }
    }
    
    console.log('\n✅ Embedding regeneration complete!');
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { regenerateEmbeddingsForDocument };