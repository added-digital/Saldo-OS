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
