import { createAdminClient } from "@/lib/supabase/admin";

import type { ToolHandler } from "./types";

export type SearchDocumentsInput = {
  query: string;
  match_count?: number;
};

type ChunkSearchRow = {
  chunk_id: string;
  document_id: string;
  chunk_text: string;
  file_name: string;
  document_type: string | null;
  similarity: number;
  storage_path: string;
};

type EmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
};

type DocumentSource = {
  file_name: string;
  document_type: string | null;
  similarity: number;
};

type DirectChunkRow = {
  id: string;
  document_id: string;
  chunk_text: string;
  embedding: unknown;
  documents:
    | {
        id: string;
        file_name: string;
        document_type: string | null;
        storage_path: string;
      }
    | null;
};

const VOYAGE_MODEL = "voyage-3";
const EXPECTED_EMBEDDING_DIM = 1024;
// Defaults tuned for token cost: chunk_text is unbounded in length, so even
// a small `match_count` can produce a fat tool result. The route compactor
// additionally truncates each excerpt to ~800 chars as a backstop.
// Bumped from 4→6 default (and 6→8 max): with only 4 chunks, the specific
// handbook section that answers a question (dress code, pets, etc.) often
// wasn't in the top hits, so the model fell back to "found nothing" even
// though the handbook covered it. Fetching more excerpts gives it the
// relevant passage to answer from. The route compactor still truncates each
// excerpt to ~800 chars, so the token cost stays bounded.
const DEFAULT_MATCH_COUNT = 6;
const MAX_MATCH_COUNT = 8;

function toVectorString(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function parseVectorEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is number => typeof item === "number");
  }
  if (typeof value !== "string") return [];

  const trimmed = value.trim();
  const normalized = trimmed.replace(/^\[/, "").replace(/\]$/, "");
  if (!normalized) return [];

  return normalized
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedQuestion(question: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is missing");
  }

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [question],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Voyage embedding failed: ${text}`);
  }

  const payload = (await response.json()) as EmbeddingResponse;
  const firstItem = Array.isArray(payload.data) ? payload.data[0] : null;
  const embedding = Array.isArray(firstItem?.embedding) ? firstItem.embedding : [];

  if (embedding.length !== EXPECTED_EMBEDDING_DIM) {
    throw new Error(
      `Voyage question embedding had unexpected length ${embedding.length} (expected ${EXPECTED_EMBEDDING_DIM}).`,
    );
  }

  return embedding;
}

/**
 * Vector search over uploaded documents. Mirrors the three-tier fallback chain
 * the existing /api/questions/ask-documents route uses, so this tool keeps
 * working even when the `search_chunks` RPC has issues:
 *
 *   1. Fast path: `search_chunks` RPC.
 *   2. Fallback: `run_generated_sql` RPC with an explicit vector dim cast
 *      (sometimes more permissive about argument typing).
 *   3. Last resort: fetch up to 500 chunks directly and compute cosine in JS.
 *
 * Documents in this CRM are not customer-scoped (firm-wide policies, service
 * descriptions, handbooks) — searches go through the admin client because
 * `document_chunks` doesn't enforce per-customer RLS.
 */
export const searchDocuments: ToolHandler<SearchDocumentsInput> = async (
  input,
) => {
  const query = input.query?.trim();
  if (!query) {
    return { error: "`query` is required.", chunks: [], sources: [] };
  }

  const matchCount = Math.min(
    Math.max(input.match_count ?? DEFAULT_MATCH_COUNT, 1),
    MAX_MATCH_COUNT,
  );

  let embedding: number[];
  try {
    embedding = await embedQuestion(query);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Embedding failed.";
    console.error("[search_documents] embedding failed:", message);
    return {
      error: `Embedding step failed: ${message}`,
      chunks: [],
      sources: [],
    };
  }

  const adminClient = createAdminClient();
  const vectorString = toVectorString(embedding);

  let rows: ChunkSearchRow[] = [];
  const failures: string[] = [];

  // ---------------------------------------------------------------------------
  // Tier 1 — search_chunks RPC
  // ---------------------------------------------------------------------------
  try {
    // Pass the vector literal as-is. The previous `${vectorString}::vector`
    // wrapped the cast INSIDE the RPC parameter value, so Postgres received
    // a string like `[0.019,...,0.020]::vector` and tried to parse the whole
    // thing as a vector literal — choking on the `::vector` text after the
    // closing brace ("22P02 invalid input syntax for type vector"). The cast
    // belongs in the SQL function signature, not the parameter.
    const { data, error } = await adminClient.rpc("search_chunks" as never, {
      query_embedding: vectorString,
      match_count: matchCount,
    } as never);

    if (error) {
      failures.push(`search_chunks RPC: ${error.message}`);
      console.error("[search_documents] search_chunks RPC failed:", error);
    } else if (Array.isArray(data)) {
      rows = data as ChunkSearchRow[];
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    failures.push(`search_chunks RPC threw: ${message}`);
    console.error("[search_documents] search_chunks RPC threw:", error);
  }

  // ---------------------------------------------------------------------------
  // Tier 2 — run_generated_sql with explicit vector dim
  // ---------------------------------------------------------------------------
  if (rows.length === 0) {
    try {
      const sql = [
        "SELECT",
        "  dc.id AS chunk_id,",
        "  dc.document_id,",
        "  dc.chunk_text,",
        "  d.file_name,",
        "  d.document_type,",
        `  1 - (dc.embedding <=> '${vectorString}'::vector(${embedding.length})) AS similarity,`,
        "  d.storage_path",
        "FROM document_chunks dc",
        "INNER JOIN documents d ON d.id = dc.document_id",
        `ORDER BY dc.embedding <=> '${vectorString}'::vector(${embedding.length})`,
        `LIMIT ${matchCount}`,
      ].join("\n");

      const { data, error } = await adminClient.rpc(
        "run_generated_sql" as never,
        { query_text: sql } as never,
      );

      if (error) {
        failures.push(`run_generated_sql: ${error.message}`);
        console.error("[search_documents] run_generated_sql failed:", error);
      } else if (Array.isArray(data)) {
        rows = data as ChunkSearchRow[];
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      failures.push(`run_generated_sql threw: ${message}`);
      console.error("[search_documents] run_generated_sql threw:", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 3 — direct fetch + JS cosine
  //
  // Last resort only — reached when both RPC paths fail. This used to fetch an
  // UNORDERED .limit(500) slice, which is a silent correctness landmine: once
  // the corpus exceeds 500 chunks it scores an arbitrary subset and can miss
  // the chunk that actually answers the question (the exact failure that made
  // handbook questions return "found nothing"). We now page through every
  // chunk in batches so the JS cosine ranks the full set, and we flag it when
  // the corpus is large enough that this degraded path is doing real work.
  // ---------------------------------------------------------------------------
  if (rows.length === 0) {
    try {
      const FETCH_BATCH = 1000;
      const MAX_TIER3_CHUNKS = 20000; // hard ceiling to bound memory/time
      const directRows: DirectChunkRow[] = [];
      let from = 0;
      let fetchError: { message: string } | null = null;

      for (;;) {
        const { data, error } = await adminClient
          .from("document_chunks")
          .select(
            "id, document_id, chunk_text, embedding, " +
              "documents!inner(id, file_name, document_type, storage_path)",
          )
          .range(from, from + FETCH_BATCH - 1);

        if (error) {
          fetchError = error;
          break;
        }

        const batch = (data ?? []) as unknown as DirectChunkRow[];
        directRows.push(...batch);

        if (batch.length < FETCH_BATCH) break; // last page
        from += FETCH_BATCH;
        if (directRows.length >= MAX_TIER3_CHUNKS) {
          failures.push(
            `direct fetch hit the ${MAX_TIER3_CHUNKS}-chunk ceiling — ranking may be incomplete. Fix the search_chunks RPC path (vector dim/recall) so this fallback isn't used.`,
          );
          break;
        }
      }

      if (fetchError) {
        failures.push(`direct fetch: ${fetchError.message}`);
        console.error("[search_documents] direct fetch failed:", fetchError);
      } else {
        rows = directRows
          .map((row) => {
            const parsed = parseVectorEmbedding(row.embedding);
            const similarity = cosineSimilarity(embedding, parsed);
            if (!row.documents) return null;
            return {
              chunk_id: row.id,
              document_id: row.document_id,
              chunk_text: row.chunk_text,
              file_name: row.documents.file_name,
              document_type: row.documents.document_type,
              similarity,
              storage_path: row.documents.storage_path,
            } satisfies ChunkSearchRow;
          })
          .filter((row): row is ChunkSearchRow => row !== null)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, matchCount);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      failures.push(`direct fetch threw: ${message}`);
      console.error("[search_documents] direct fetch threw:", error);
    }
  }

  if (rows.length === 0) {
    return {
      error:
        "All document-search paths failed. " +
        (failures.length > 0 ? `Details: ${failures.join(" | ")}` : ""),
      chunks: [],
      sources: [],
    };
  }

  // Compact chunks for Claude — keep the text but trim metadata.
  const chunks = rows.map((row, index) => ({
    rank: index + 1,
    file_name: row.file_name,
    document_type: row.document_type,
    similarity: row.similarity,
    excerpt: row.chunk_text,
  }));

  // Dedupe sources by file_name, keep the highest similarity.
  const sourceMap = new Map<string, DocumentSource>();
  for (const row of rows) {
    const key = row.file_name?.trim().toLowerCase();
    if (!key) continue;
    const existing = sourceMap.get(key);
    if (!existing || row.similarity > existing.similarity) {
      sourceMap.set(key, {
        file_name: row.file_name,
        document_type: row.document_type,
        similarity: row.similarity,
      });
    }
  }

  return {
    query,
    chunk_count: chunks.length,
    chunks,
    sources: Array.from(sourceMap.values()),
    fallbacks_used: failures.length > 0 ? failures : undefined,
  };
};
