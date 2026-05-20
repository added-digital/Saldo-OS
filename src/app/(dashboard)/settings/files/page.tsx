"use client"

import * as React from "react"
import { Download, FileText, FolderPlus, FolderTree, Loader2, Trash2, Upload } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useUser } from "@/hooks/use-user"
import { useTranslation } from "@/hooks/use-translation"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

const STORAGE_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_FILES_BUCKET ?? "crm-files"
const ROOT_FOLDER = process.env.NEXT_PUBLIC_SUPABASE_FILES_ROOT ?? "files"
const SERVICES_FOLDER_KEY = process.env.NEXT_PUBLIC_SUPABASE_SERVICES_FOLDER ?? "Tjanster"
const EMPTY_FOLDER_PLACEHOLDER = ".emptyFolderPlaceholder"

type StorageListItem = {
  id: string | null
  name: string
  metadata?: {
    size?: number
  } | null
  updated_at?: string
}

type DeleteTarget = {
  name: string
  kind: "file" | "folder" | "files"
}

function joinStoragePath(...parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
    .filter((part) => part.length > 0)
    .join("/")
}

function sanitizeStorageSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")

  return normalized
}

function normalizeFolderName(value: string): string {
  return sanitizeStorageSegment(value)
}

function normalizeFileName(value: string): string {
  const trimmed = value.trim()
  const extensionIndex = trimmed.lastIndexOf(".")

  if (extensionIndex <= 0 || extensionIndex === trimmed.length - 1) {
    return sanitizeStorageSegment(trimmed)
  }

  const baseName = sanitizeStorageSegment(trimmed.slice(0, extensionIndex))
  const extension = sanitizeStorageSegment(trimmed.slice(extensionIndex + 1)).toLowerCase()

  if (!baseName) {
    return extension ? `file.${extension}` : "file"
  }

  return extension ? `${baseName}.${extension}` : baseName
}

function splitFileName(value: string): { baseName: string; extension: string } {
  const extensionIndex = value.lastIndexOf(".")

  if (extensionIndex <= 0 || extensionIndex === value.length - 1) {
    return {
      baseName: value,
      extension: "",
    }
  }

  return {
    baseName: value.slice(0, extensionIndex),
    extension: value.slice(extensionIndex + 1),
  }
}

function isStorageConflictError(message: string | undefined): boolean {
  if (!message) return false
  const normalized = message.toLowerCase()
  return (
    normalized.includes("already exists") ||
    normalized.includes("duplicate") ||
    normalized.includes("conflict")
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function renderSegmentLabel(segment: string, t: (key: string, fallback?: string) => string): string {
  if (segment === SERVICES_FOLDER_KEY) {
    return t("settings.files.servicesFolder", "Tjänster")
  }

  return segment
}

function getCurrentFolderLabel(
  currentFolder: string,
  t: (key: string, fallback?: string) => string,
): string {
  const segments = currentFolder.split("/").filter(Boolean)
  const lastSegment = segments[segments.length - 1]

  if (!lastSegment) {
    return t("settings.tabs.files", "Files")
  }

  return renderSegmentLabel(lastSegment, t)
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return "-"
  if (value < 1024) return `${value} B`

  const units = ["KB", "MB", "GB"]
  let size = value / 1024
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`
}

export default function SettingsFilesPage() {
  const { isAdmin } = useUser()
  const { t } = useTranslation()

  const [currentFolder, setCurrentFolder] = React.useState(ROOT_FOLDER)
  const [items, setItems] = React.useState<StorageListItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [creatingFolder, setCreatingFolder] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [deletingPath, setDeletingPath] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null)
  const [selectedFileNames, setSelectedFileNames] = React.useState<string[]>([])
  const [folderName, setFolderName] = React.useState("")
  const [selectedFiles, setSelectedFiles] = React.useState<File[]>([])
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const pathSegments = React.useMemo(() => currentFolder.split("/").filter(Boolean), [currentFolder])
  const canUploadToCurrentFolder = currentFolder !== ROOT_FOLDER
  const currentFolderLabel = React.useMemo(() => getCurrentFolderLabel(currentFolder, t), [currentFolder, t])
  const fileItems = React.useMemo(() => items.filter((item) => item.id !== null), [items])
  const allFilesSelected = fileItems.length > 0 && fileItems.every((item) => selectedFileNames.includes(item.name))


  const loadFolder = React.useCallback(async (folderPath: string) => {
    const supabase = createClient()
    setLoading(true)

    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(folderPath, {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    })

    if (error) {
      toast.error(error.message || t("settings.files.toast.loadFailed", "Failed to load files"))
      setItems([])
      setLoading(false)
      return
    }

    const filteredItems = (data ?? []).filter((item) => item.name !== EMPTY_FOLDER_PLACEHOLDER)
    setItems(filteredItems as StorageListItem[])
    setSelectedFileNames((current) =>
      current.filter((name) => filteredItems.some((item) => item.id !== null && item.name === name)),
    )
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void loadFolder(currentFolder)
  }, [currentFolder, loadFolder])

  React.useEffect(() => {
    const supabase = createClient()

    async function ensureRootFolder() {
      const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(joinStoragePath(ROOT_FOLDER, EMPTY_FOLDER_PLACEHOLDER), new Blob([]), {
          contentType: "text/plain",
          upsert: false,
        })

      if (error) {
        return
      }

      const { error: servicesError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(joinStoragePath(ROOT_FOLDER, SERVICES_FOLDER_KEY, EMPTY_FOLDER_PLACEHOLDER), new Blob([]), {
          contentType: "text/plain",
          upsert: false,
        })

      if (!servicesError) {
        await loadFolder(ROOT_FOLDER)
      }
    }

    void ensureRootFolder()
  }, [loadFolder])

  async function handleCreateFolder() {
    const normalizedFolderName = normalizeFolderName(folderName)
    if (!normalizedFolderName) {
      toast.error(t("settings.files.toast.folderRequired", "Folder name is required"))
      return
    }

    setCreatingFolder(true)
    const supabase = createClient()
    const placeholderPath = joinStoragePath(
      currentFolder,
      normalizedFolderName,
      EMPTY_FOLDER_PLACEHOLDER,
    )

    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(placeholderPath, new Blob([]), {
      contentType: "text/plain",
      upsert: false,
    })

    if (error) {
      toast.error(error.message || t("settings.files.toast.folderCreateFailed", "Failed to create folder"))
      setCreatingFolder(false)
      return
    }

    toast.success(t("settings.files.toast.folderCreated", "Folder created"))
    setFolderName("")
    setCreatingFolder(false)
    await loadFolder(currentFolder)
  }

  async function handleUploadFiles(filesOverride?: File[]) {
    const filesToUpload = filesOverride?.length ? filesOverride : selectedFiles

    if (filesToUpload.length === 0) {
      toast.error(t("settings.files.toast.chooseFiles", "Choose file(s) first"))
      return
    }

    setUploading(true)
    const supabase = createClient()
    let successCount = 0
    const failedFiles: Array<{ name: string; reason: string }> = []

    for (const fileToUpload of filesToUpload) {
      const normalizedFileName = normalizeFileName(fileToUpload.name)
      const fileNameForStorage = normalizedFileName || "file"
      const { baseName, extension } = splitFileName(fileNameForStorage)

      let attempt = 0
      let objectPath = joinStoragePath(currentFolder, fileNameForStorage)
      let uploadError: { message?: string } | null = null

      while (attempt < 50) {
        const uploadResult = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, fileToUpload, {
          contentType: fileToUpload.type || "application/octet-stream",
          upsert: false,
        })

        if (!uploadResult.error) {
          uploadError = null
          break
        }

        uploadError = uploadResult.error
        if (!isStorageConflictError(uploadResult.error.message)) {
          break
        }

        attempt += 1
        const candidateName = extension
          ? `${baseName}-${attempt}.${extension}`
          : `${baseName}-${attempt}`
        objectPath = joinStoragePath(currentFolder, candidateName)
      }

      if (uploadError) {
        failedFiles.push({
          name: fileToUpload.name,
          reason: uploadError.message || "Upload failed",
        })
        continue
      }

      try {
        await ingestUploadedDocument({
          objectPath,
          fileName: fileToUpload.name,
          fileType: fileToUpload.type || "application/octet-stream",
          documentType: currentFolderLabel,
        })
        successCount += 1
      } catch (error) {
        // If ingestion fails, attempt to remove the uploaded object and capture any deletion errors
        let deletionErrorMessage = ""

        try {
          const { error: removeError } = await supabase.storage.from(STORAGE_BUCKET).remove([objectPath])
          if (removeError) {
            deletionErrorMessage = removeError.message || String(removeError)
          }
        } catch (removeErr) {
          deletionErrorMessage = removeErr instanceof Error ? removeErr.message : String(removeErr)
        }

        const ingestMessage = error instanceof Error ? error.message : "Indexing failed after upload"
        const combinedMessage = deletionErrorMessage
          ? `${ingestMessage}; cleanup failed: ${deletionErrorMessage}`
          : ingestMessage

        failedFiles.push({
          name: fileToUpload.name,
          reason: combinedMessage,
        })
      }
    }

    setSelectedFiles([])
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
    setUploading(false)
    await loadFolder(currentFolder)

    if (successCount > 0) {
      toast.success(
        successCount === 1
          ? t("settings.files.toast.uploadSingle", "1 file uploaded and indexed")
          : `${successCount} ${t("settings.files.toast.uploadManySuffix", "files uploaded and indexed")}`,
      )
    }

    if (failedFiles.length > 0) {
      if (failedFiles.length === 1) {
        toast.error(
          `${t("settings.files.toast.uploadFailedForFile", "Upload failed for")} ${failedFiles[0].name}: ${failedFiles[0].reason}`,
        )
      } else {
        const reasonPreview = failedFiles
          .slice(0, 3)
          .map((file) => `${file.name}: ${file.reason}`)
          .join(" | ")
        const remaining = failedFiles.length - 3
        toast.error(
          `${t("settings.files.toast.uploadFailedForCount", "Upload failed for")} ${failedFiles.length} ${t("settings.files.toast.uploadFiles", "files.")} ${reasonPreview}${remaining > 0 ? ` | +${remaining} ${t("settings.files.toast.uploadFailedMore", "more")}` : ""}`,
        )
      }
    }
  }

  function handleUploadButtonClick() {
    fileInputRef.current?.click()
  }

  async function handleDownloadFile(itemName: string) {
    const supabase = createClient()
    const objectPath = joinStoragePath(currentFolder, itemName)
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(objectPath)

    if (error || !data) {
      toast.error(error?.message || t("settings.files.toast.downloadFailed", "Failed to download file"))
      return
    }

    const downloadUrl = URL.createObjectURL(data)
    const link = document.createElement("a")
    link.href = downloadUrl
    link.download = itemName
    link.click()
    URL.revokeObjectURL(downloadUrl)
  }

  async function removeIndexedDocuments(storagePaths: string[]) {
    if (storagePaths.length === 0) return

    const response = await fetch("/api/documents/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        storage_paths: storagePaths,
      }),
    })

    if (!response.ok) {
      throw new Error(t("settings.files.toast.indexDeleteFailed", "Failed to delete indexed document records"))
    }
  }

  async function ingestUploadedDocument(input: {
    objectPath: string
    fileName: string
    fileType: string
    documentType: string
  }) {
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetch("/api/documents/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          storage_path: input.objectPath,
          file_name: input.fileName,
          file_type: input.fileType,
          document_type: input.documentType,
        }),
      })

      if (response.ok) {
        return
      }

      if (attempt < maxAttempts) {
        await delay(350 * attempt)
        continue
      }

      let detailMessage = ""
      try {
        const errorPayload = (await response.json()) as { error?: string; detail?: string; message?: string }
        detailMessage = errorPayload.detail || errorPayload.message || errorPayload.error || ""
      } catch {
        detailMessage = await response.text()
      }

      throw new Error(detailMessage || t("settings.files.toast.indexFailed", "Failed to index uploaded file"))
    }
  }

  async function handleDeleteFile(itemName: string) {
    const objectPath = joinStoragePath(currentFolder, itemName)
    const supabase = createClient()

    setDeletingPath(objectPath)
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([objectPath])

    if (error) {
      toast.error(error.message || t("settings.files.toast.fileDeleteFailed", "Failed to delete file"))
      setDeletingPath(null)
      return
    }

    try {
      await removeIndexedDocuments([objectPath])
    } catch {
      toast.error(t("settings.files.toast.indexReferencesFailed", "File was deleted, but indexed references could not be removed"))
    }

    toast.success(t("settings.files.toast.fileDeleted", "File deleted"))
    setDeleteTarget(null)
    setDeletingPath(null)
    await loadFolder(currentFolder)
  }

  async function handleDeleteSelectedFiles(fileNames: string[]) {
    if (fileNames.length === 0) {
      setDeleteTarget(null)
      return
    }

    const objectPaths = fileNames.map((fileName) => joinStoragePath(currentFolder, fileName))
    const supabase = createClient()

    setDeletingPath("__batch__")
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(objectPaths)

    if (error) {
      toast.error(error.message || t("settings.files.toast.batchDeleteFailed", "Failed to delete selected files"))
      setDeletingPath(null)
      return
    }

    try {
      await removeIndexedDocuments(objectPaths)
    } catch {
      toast.error(t("settings.files.toast.someIndexFailed", "Some indexed references could not be removed"))
    }

    toast.success(
      fileNames.length === 1
        ? t("settings.files.toast.batchDeleteSingle", "1 file deleted")
        : `${fileNames.length} ${t("settings.files.toast.batchDeleteManySuffix", "files deleted")}`,
    )
    setSelectedFileNames([])
    setDeleteTarget(null)
    setDeletingPath(null)
    await loadFolder(currentFolder)
  }

  function toggleSelectFile(fileName: string, checked: boolean) {
    setSelectedFileNames((current) => {
      if (checked) {
        return current.includes(fileName) ? current : [...current, fileName]
      }

      return current.filter((name) => name !== fileName)
    })
  }

  function toggleSelectAllFiles(checked: boolean) {
    if (checked) {
      setSelectedFileNames(fileItems.map((item) => item.name))
      return
    }

    setSelectedFileNames([])
  }

  async function collectFolderObjectPaths(folderPath: string): Promise<string[]> {
    const supabase = createClient()
    const queue = [folderPath]
    const objectPaths: string[] = []

    while (queue.length > 0) {
      const nextPath = queue.shift()
      if (!nextPath) {
        continue
      }

      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(nextPath, {
        limit: 100,
        offset: 0,
        sortBy: { column: "name", order: "asc" },
      })

      if (error) {
        throw new Error(error.message || t("settings.files.toast.folderReadFailed", "Failed to read folder"))
      }

      for (const item of data ?? []) {
        const itemPath = joinStoragePath(nextPath, item.name)
        if (item.id === null) {
          queue.push(itemPath)
        } else {
          objectPaths.push(itemPath)
        }
      }
    }

    return objectPaths
  }

  async function handleDeleteFolder(folderName: string) {
    const folderPath = joinStoragePath(currentFolder, folderName)
    const supabase = createClient()

    setDeletingPath(folderPath)

    try {
      const objectPaths = await collectFolderObjectPaths(folderPath)

      if (objectPaths.length === 0) {
        setDeleteTarget(null)
        setDeletingPath(null)
        await loadFolder(currentFolder)
        return
      }

      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(objectPaths)
      if (error) {
        toast.error(error.message || t("settings.files.toast.folderDeleteFailed", "Failed to delete folder"))
        setDeletingPath(null)
        return
      }

      try {
        await removeIndexedDocuments(objectPaths)
      } catch {
        toast.error(t("settings.files.toast.folderIndexFailed", "Folder was deleted, but indexed references could not be fully removed"))
      }

      toast.success(t("settings.files.toast.folderDeleted", "Folder deleted"))
      setDeleteTarget(null)
      setDeletingPath(null)
      await loadFolder(currentFolder)
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings.files.toast.folderDeleteFailed", "Failed to delete folder")
      toast.error(message)
      setDeletingPath(null)
    }
  }

  if (!isAdmin) {
    return <div className="h-40 rounded-lg border bg-muted/20" />
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.tabs.files", "Files")}</CardTitle>
          <CardDescription>
            {t("settings.files.description", "Upload and organize files in folders for future AI references.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {pathSegments.map((segment, index) => {
              const segmentPath = pathSegments.slice(0, index + 1).join("/")
              const isLast = index === pathSegments.length - 1

              return (
                <React.Fragment key={segmentPath}>
                  <Button
                    variant={isLast ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setCurrentFolder(segmentPath)}
                  >
                    {renderSegmentLabel(segment, t)}
                  </Button>
                  {!isLast ? <span className="text-muted-foreground">/</span> : null}
                </React.Fragment>
              )
            })}

          </div>

          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <Input
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder={`${t("settings.files.newFolderPlaceholder", "New folder inside")} ${currentFolderLabel}`}
            />
            <Button onClick={handleCreateFolder} disabled={creatingFolder}>
              {creatingFolder ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
              {t("settings.files.createFolder", "Create folder")}
            </Button>
          </div>

          {canUploadToCurrentFolder ? (
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  setSelectedFiles(files)

                  if (files.length > 0) {
                    void handleUploadFiles(files)
                  }
                }}
              />
              <Button onClick={handleUploadButtonClick} disabled={uploading}>
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {t("settings.files.uploadFile", "Upload file")}
              </Button>
            </div>
          ) : null}

          {loading ? (
            <div className="h-24 animate-pulse rounded-md border bg-muted/20" />
          ) : items.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              {t("settings.files.empty", "No files or folders yet in this path.")}
            </div>
          ) : (
            <div className="space-y-2">
              {fileItems.length > 0 ? (
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={allFilesSelected}
                      onCheckedChange={(checked) => toggleSelectAllFiles(Boolean(checked))}
                    />
                    <span>{t("settings.files.selectAll", "Select all files")}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    disabled={selectedFileNames.length === 0 || deletingPath === "__batch__"}
                    onClick={() =>
                      setDeleteTarget({
                        name: `${selectedFileNames.length} ${
                          selectedFileNames.length === 1
                            ? t("settings.files.filesCountSingular", "file")
                            : t("settings.files.filesCountPlural", "files")
                        }`,
                        kind: "files",
                      })
                    }
                  >
                    {deletingPath === "__batch__" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    {t("settings.files.deleteSelected", "Delete selected")}
                  </Button>
                </div>
              ) : null}

              {items.map((item) => {
                const isFolder = item.id === null

                return (
                  <div
                    key={`${item.name}-${item.updated_at ?? ""}`}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div className="flex items-center gap-3">
                      {isFolder ? (
                        <FolderTree className="size-4 text-muted-foreground" />
                      ) : (
                        <Checkbox
                          checked={selectedFileNames.includes(item.name)}
                          onCheckedChange={(checked) => toggleSelectFile(item.name, Boolean(checked))}
                        />
                      )}
                      {!isFolder ? <FileText className="size-4 text-muted-foreground" /> : null}
                      <button
                        type="button"
                        className="cursor-pointer text-left"
                        onClick={() => {
                          if (isFolder) {
                            setCurrentFolder(joinStoragePath(currentFolder, item.name))
                            return
                          }
                          void handleDownloadFile(item.name)
                        }}
                      >
                        <p className="text-sm font-medium hover:underline">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {isFolder ? t("settings.files.folder", "Folder") : formatBytes(item.metadata?.size)}
                        </p>
                      </button>
                    </div>

                    {isFolder ? (
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setCurrentFolder(joinStoragePath(currentFolder, item.name))}>
                          {t("settings.files.open", "Open")}
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="text-destructive"
                          onClick={() => setDeleteTarget({ name: item.name, kind: "folder" })}
                          disabled={deletingPath === joinStoragePath(currentFolder, item.name)}
                        >
                          {deletingPath === joinStoragePath(currentFolder, item.name) ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                          <span className="sr-only">{t("settings.files.deleteFolderSr", "Delete folder")}</span>
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleDownloadFile(item.name)}>
                          <Download className="size-4" />
                          {t("settings.files.download", "Download")}
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="text-destructive"
                          onClick={() => setDeleteTarget({ name: item.name, kind: "file" })}
                          disabled={deletingPath === joinStoragePath(currentFolder, item.name)}
                        >
                          {deletingPath === joinStoragePath(currentFolder, item.name) ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                          <span className="sr-only">{t("settings.files.deleteFileSr", "Delete file")}</span>
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={
          deleteTarget?.kind === "folder"
            ? t("settings.files.confirm.deleteFolderTitle", "Delete folder")
            : deleteTarget?.kind === "files"
              ? t("settings.files.confirm.deleteFilesTitle", "Delete files")
              : t("settings.files.confirm.deleteFileTitle", "Delete file")
        }
        description={
          deleteTarget?.kind === "files"
            ? `${t("settings.files.confirm.deletePrefix", "Permanently delete")} ${deleteTarget.name}?`
            : deleteTarget
              ? `${t("settings.files.confirm.deletePrefix", "Permanently delete")} "${deleteTarget.name}"?`
              : t("settings.files.confirm.deleteGeneric", "Permanently delete item?")
        }
        confirmLabel={t("settings.files.confirm.delete", "Delete")}
        variant="destructive"
        loading={
          deleteTarget
            ? deleteTarget.kind === "files"
              ? deletingPath === "__batch__"
              : deletingPath === joinStoragePath(currentFolder, deleteTarget.name)
            : false
        }
        onConfirm={async () => {
          if (!deleteTarget) return
          if (deleteTarget.kind === "files") {
            await handleDeleteSelectedFiles(selectedFileNames)
            return
          }
          if (deleteTarget.kind === "folder") {
            await handleDeleteFolder(deleteTarget.name)
            return
          }

          await handleDeleteFile(deleteTarget.name)
        }}
      />
    </div>
  )
}
