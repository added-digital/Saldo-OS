// Shared upload rules for file attachments (engagements, leads). Kept in one
// place so the two features can't drift apart on what they accept — the limits
// are enforced client-side for a decent error message, while the storage RLS
// prefix is what actually gates access.

export const STORAGE_BUCKET =
  process.env.NEXT_PUBLIC_SUPABASE_FILES_BUCKET ?? "crm-files"

/** 25 MB, per the product decision. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "csv",
  "txt",
  "zip",
]

/** The `accept` attribute for a file input, derived from the allow-list. */
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.map(
  (e) => `.${e}`,
).join(",")

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/**
 * Enough of the Supabase client for the purge below — keeps this file free of a
 * hard dependency on the generated Database type. PromiseLike, not Promise:
 * postgrest returns a thenable query builder, which awaits the same way.
 *
 * Deliberately NOT the parameter type: structurally matching a real
 * SupabaseClient against this makes tsc re-derive postgrest's generics and blow
 * the instantiation-depth limit (TS2589) in the larger call sites. The client
 * comes in as `unknown` and is narrowed here instead — one cast in one place,
 * rather than a cast at every caller.
 */
type StorageCapableClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => PromiseLike<{ data: unknown; error: unknown }>
    }
  }
  storage: {
    from: (bucket: string) => {
      remove: (paths: string[]) => PromiseLike<{ error: unknown }>
    }
  }
}

/**
 * Delete a parent's stored files BEFORE the parent row goes.
 *
 * The metadata rows disappear on their own — they're `ON DELETE CASCADE` — but
 * a cascade in Postgres cannot reach into object storage, so without this the
 * bytes stay in the bucket forever with nothing pointing at them. It has to run
 * first, too: once the parent is gone the cascade has already taken the rows
 * that told us which paths to remove.
 *
 * Best-effort by design. A failed purge leaves orphaned bytes, which is a
 * housekeeping problem; blocking the delete the user asked for would be worse.
 * Returns how many objects it removed so callers can log rather than surface it.
 */
export async function purgeAttachmentObjects(
  client: unknown,
  table: "lead_attachments" | "engagement_attachments",
  parentColumn: "lead_id" | "engagement_id",
  parentId: string,
): Promise<number> {
  const supabase = client as StorageCapableClient
  const { data, error } = await supabase
    .from(table)
    .select("storage_path")
    .eq(parentColumn, parentId)
  if (error) return 0

  const paths = ((data ?? []) as Array<{ storage_path: string }>)
    .map((r) => r.storage_path)
    .filter(Boolean)
  if (paths.length === 0) return 0

  const { error: removeError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .remove(paths)
  if (removeError) {
    console.error(`Failed to purge ${table} objects for ${parentId}`, removeError)
    return 0
  }
  return paths.length
}
