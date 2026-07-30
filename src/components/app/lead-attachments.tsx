"use client"

import * as React from "react"
import { Download, Loader2, Paperclip, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { formatBytes, formatDateTime } from "@/lib/utils"
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  STORAGE_BUCKET,
  fileExtension,
} from "@/lib/attachments"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type { LeadAttachment } from "@/types/database"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * Files belonging to a lead: quotes, offer drafts, anything the prospect sent
 * over. Bytes live in the private `crm-files` bucket under `leads/<id>/`; this
 * component only ever holds the metadata rows and hands out short-lived signed
 * URLs when someone opens a file (migration 00108).
 */
export function LeadAttachments({ leadId }: { leadId: string }) {
  const { t } = useTranslation()
  const { user } = useUser()
  const [items, setItems] = React.useState<LeadAttachment[] | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const [dragActive, setDragActive] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("lead_attachments")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
      if (cancelled) return
      if (error) {
        // An empty list would read as "no files"; say the load failed instead.
        toast.error(t("leads.files.loadFailed", "Couldn't load files"))
        setItems([])
        return
      }
      setItems((data ?? []) as unknown as LeadAttachment[])
    })()
    return () => {
      cancelled = true
    }
  }, [leadId, t])

  async function uploadFiles(files: FileList | File[] | null) {
    if (!files) return
    const list = Array.from(files)
    if (list.length === 0) return
    const supabase = createClient()
    setUploading(true)
    try {
      for (const file of list) {
        const ext = fileExtension(file.name)
        if (!ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) {
          toast.error(`${file.name}: ${t("leads.files.badType", "That file type isn't allowed")}`)
          continue
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast.error(`${file.name}: ${t("leads.files.tooLarge", "File is too large (max 25 MB)")}`)
          continue
        }

        const path = `leads/${leadId}/${crypto.randomUUID()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, file, { contentType: file.type || undefined, upsert: false })
        if (uploadError) {
          toast.error(`${file.name}: ${t("leads.files.uploadFailed", "Upload failed")}`)
          continue
        }

        const { data: inserted, error: insertError } = await supabase
          .from("lead_attachments")
          .insert({
            lead_id: leadId,
            storage_path: path,
            file_name: file.name,
            file_type: file.type || null,
            file_size: file.size,
            uploaded_by: user?.id ?? null,
          } as never)
          .select("*")
          .single()

        if (insertError || !inserted) {
          // Don't leave the bytes behind with no row pointing at them.
          await supabase.storage.from(STORAGE_BUCKET).remove([path])
          toast.error(`${file.name}: ${t("leads.files.uploadFailed", "Upload failed")}`)
          continue
        }

        setItems((cur) => [inserted as unknown as LeadAttachment, ...(cur ?? [])])
        toast.success(t("leads.files.uploaded", "File attached"))
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function openFile(att: LeadAttachment) {
    const supabase = createClient()
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(att.storage_path, 60)
    if (error || !data?.signedUrl) {
      toast.error(t("leads.files.openFailed", "Couldn't open file"))
      return
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer")
  }

  async function deleteFile(att: LeadAttachment) {
    const supabase = createClient()
    setDeletingId(att.id)
    const { error: removeError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([att.storage_path])
    // Clear the row even if the object was already gone, so a half-deleted file
    // doesn't linger in the list forever.
    const { error: dbError } = await supabase
      .from("lead_attachments")
      .delete()
      .eq("id", att.id)
    setDeletingId(null)
    if (dbError || removeError) {
      toast.error(t("leads.files.deleteFailed", "Couldn't remove file"))
      if (dbError) return
    }
    setItems((cur) => (cur ?? []).filter((a) => a.id !== att.id))
    toast.success(t("leads.files.deleted", "File removed"))
  }

  const count = items?.length ?? 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Paperclip className="size-4 text-muted-foreground" />
            {t("leads.files.title", "Files")}
            {count > 0 ? (
              <Badge variant="outline" className="text-[11px]">
                {count}
              </Badge>
            ) : null}
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {uploading ? t("leads.files.uploading", "Uploading…") : t("leads.files.add", "Add file")}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept={ATTACHMENT_ACCEPT}
          onChange={(e) => void uploadFiles(e.target.files)}
        />

        {/* Drop target: dragging a quote straight from the mail client onto the
            card is the common case, so the whole list area accepts it. */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragActive(false)
            void uploadFiles(e.dataTransfer.files)
          }}
          className={
            dragActive
              ? "rounded-md border-2 border-dashed border-primary bg-primary/5 p-2"
              : "rounded-md border-2 border-dashed border-transparent p-2"
          }
        >
          {items === null ? (
            <p className="text-sm text-muted-foreground">{t("leads.files.loading", "Loading…")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("leads.files.empty", "No files yet — drop one here or use Add file.")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((att) => (
                <li key={att.id} className="flex items-center gap-2 rounded-md border p-2">
                  <button
                    type="button"
                    onClick={() => void openFile(att)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={att.file_name}
                  >
                    <Download className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{att.file_name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatBytes(att.file_size)} · {formatDateTime(att.created_at)}
                      </span>
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground hover:text-semantic-error"
                    disabled={deletingId === att.id}
                    onClick={() => void deleteFile(att)}
                  >
                    {deletingId === att.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    <span className="sr-only">{t("leads.files.remove", "Remove file")}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {t("leads.files.hint", "Up to 25 MB. PDF, Office, images, CSV, TXT or ZIP.")}
        </p>
      </CardContent>
    </Card>
  )
}
