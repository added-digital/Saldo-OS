-- Fix document search recall for the chat assistant's search_documents tool.
--
-- Root cause
-- ----------
-- Both ingestion (api/documents/ingest) and querying (search_documents,
-- ask-documents) embed text with voyage-3, which produces 1024-dim vectors.
-- But search_chunks (migration 00045) declares its parameter as VECTOR(1536),
-- so a 1024-dim query vector can't be coerced to the parameter type and the
-- fast indexed path errors out. search_documents then limps along on its
-- fallbacks.
--
-- On top of that, the ivfflat index (migration 00044) uses the default
-- probes = 1 against lists = 100, i.e. each query only scans 1% of the vector
-- space. That's approximate search with poor recall: as the document corpus
-- grew, the specific chunk that answers a question (e.g. the pets/dogs rule in
-- the office policy) stopped landing in the single scanned cluster, so it was
-- never returned — producing "I searched but found nothing" even though the
-- content is present.
--
-- This migration:
--   1. Redefines search_chunks with a VECTOR(1024) parameter so it matches the
--      voyage-3 embeddings the app actually stores and queries.
--   2. Sets ivfflat.probes = 10 for this function so it scans 10% of the
--      clusters — a large recall improvement at negligible latency for a
--      handbook-sized corpus, while still using the index.
--
-- NOTE on dimensions: the stored embeddings are 1024-dim (voyage-3). If the
-- live `document_chunks.embedding` column is still typed VECTOR(1536) from
-- migration 00044, 1024-dim inserts would have been rejected — so a column
-- that currently holds data is already effectively 1024-dim. This migration
-- only touches the function; it does not alter the column. If a future check
-- shows the column typmod is genuinely 1536, re-embed/realign the column
-- separately before relying on the index.

-- NOTE: ivfflat.probes is set inside the body via set_config(..., is_local=true)
-- rather than the function-level `SET ivfflat.probes = 10` clause. On Supabase
-- a non-superuser can't pin that GUC in the CREATE FUNCTION SET clause
-- (ERROR 42501 permission denied), but set_config with is_local=true is a
-- normal USERSET change scoped to this call's transaction and is permitted.
-- The live function's OUT-parameter row type differs from this definition, and
-- CREATE OR REPLACE can't change a function's return type — so drop first, then
-- recreate. This drops only the function, never the document_chunks data.
DROP FUNCTION IF EXISTS public.search_chunks(vector, integer);

CREATE FUNCTION public.search_chunks(
  query_embedding VECTOR(1024),
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  chunk_text TEXT,
  file_name TEXT,
  document_type TEXT,
  similarity DOUBLE PRECISION,
  storage_path TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  -- Scan 10 of 100 ivfflat lists instead of the default 1 → much better
  -- recall. is_local=true confines the change to this function's transaction.
  PERFORM set_config('ivfflat.probes', '10', true);

  RETURN QUERY
  SELECT
    dc.id,
    d.id,
    dc.chunk_text,
    d.file_name,
    d.document_type,
    1 - (dc.embedding <=> query_embedding),
    d.storage_path
  FROM document_chunks dc
  INNER JOIN documents d ON d.id = dc.document_id
  ORDER BY dc.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.search_chunks(vector, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_chunks(vector, int) TO service_role;

COMMENT ON FUNCTION public.search_chunks(vector, int) IS
  'Vector KNN over document_chunks for the assistant. Parameter is VECTOR(1024) to match voyage-3 embeddings; ivfflat.probes=10 for recall. SECURITY INVOKER.';
