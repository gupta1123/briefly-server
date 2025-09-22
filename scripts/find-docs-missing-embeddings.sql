-- SQL query to identify documents missing embeddings
-- Run this in your Supabase SQL editor

SELECT 
    d.id,
    d.title,
    COUNT(dc.id) as chunk_count,
    SUM(CASE WHEN dc.embedding IS NOT NULL THEN 1 ELSE 0 END) as chunks_with_embeddings
FROM documents d
LEFT JOIN doc_chunks dc ON d.id = dc.doc_id
WHERE d.org_id = '5f4fa858-8ba2-4f46-988b-58ac0b2a948d'
GROUP BY d.id, d.title
HAVING SUM(CASE WHEN dc.embedding IS NOT NULL THEN 1 ELSE 0 END) = 0
AND COUNT(dc.id) > 0;