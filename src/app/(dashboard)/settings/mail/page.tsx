"use client"

import * as React from "react"
import {
  ChevronDown,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useUser } from "@/hooks/use-user"
import { useTranslation } from "@/hooks/use-translation"
import { cn } from "@/lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { MailTemplate } from "@/types/database"
import { toast } from "sonner"

type MailTemplateType = "plain" | "plain_os" | "default" | "campaign"
// Kept for clarity at call sites — every built-in option is now also a valid
// persisted template_type, so this is just an alias.
type BuiltinTemplateType = MailTemplateType

type BuiltinTemplatePreview = {
  id: BuiltinTemplateType
  name: string
  html: string
}

type EditorPreviewTemplate = "plain" | "content" | "campaign"

type TemplateEditorState = {
  id: string | null
  name: string
  templateType: MailTemplateType
  isActive: boolean
  subject: string
  body: string
  title: string
  previewText: string
  greeting: string
  paragraphs: string
  ctaLabel: string
  ctaUrl: string
  footnote: string
  brandName: string
}

function toParagraphs(raw: string): string[] {
  return raw
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => {
      const collapsed = paragraph
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n")
      if (collapsed === "---") return "\u200B"
      return collapsed
    })
    .filter((paragraph) => paragraph.length > 0)
}

function createDefaultEditorState(
  t: (key: string, fallback?: string) => string,
): TemplateEditorState {
  return {
    id: null,
    name: "",
    templateType: "default",
    isActive: true,
    subject: "",
    body: "",
    title: t("settings.mail.defaults.title", "Hello, @customer"),
    previewText: t("settings.mail.defaults.previewText", "Quick update from Saldo"),
    greeting: "",
    paragraphs: t(
      "settings.mail.defaults.paragraphs",
      "This is a preview of your custom email content.",
    ),
    ctaLabel: t("settings.mail.defaults.ctaLabel", "Call to action"),
    ctaUrl: process.env.NEXT_PUBLIC_APP_URL || "",
    footnote: "",
    brandName: "Saldo Redovisning",
  }
}

function toTemplatePayload(state: TemplateEditorState): Record<string, unknown> {
  if (state.templateType === "plain") {
    return {
      subject: state.subject,
      body: state.body,
    }
  }

  return {
    subject: state.subject,
    title: state.title,
    previewText: state.previewText,
    greeting: state.greeting,
    paragraphs: toParagraphs(state.paragraphs),
    ctaLabel: state.ctaLabel,
    ctaUrl: state.ctaUrl,
    footnote: state.footnote,
    brandName: state.brandName,
  }
}

function parseTemplatePayload(
  template: MailTemplate,
  t: (key: string, fallback?: string) => string,
): TemplateEditorState {
  const payload = template.payload ?? {}
  const defaultState = createDefaultEditorState(t)

  return {
    ...defaultState,
    id: template.id,
    name: template.name,
    templateType: template.template_type,
    isActive: template.is_active,
    subject: typeof payload.subject === "string" ? payload.subject : defaultState.subject,
    body: typeof payload.body === "string" ? payload.body : defaultState.body,
    title: typeof payload.title === "string" ? payload.title : defaultState.title,
    previewText:
      typeof payload.previewText === "string"
        ? payload.previewText
        : defaultState.previewText,
    greeting:
      typeof payload.greeting === "string" ? payload.greeting : defaultState.greeting,
    paragraphs: Array.isArray(payload.paragraphs)
      ? payload.paragraphs
          .filter((entry): entry is string => typeof entry === "string")
          .join("\n\n")
      : typeof payload.paragraphs === "string"
        ? payload.paragraphs
        : defaultState.paragraphs,
    ctaLabel:
      typeof payload.ctaLabel === "string" ? payload.ctaLabel : defaultState.ctaLabel,
    ctaUrl: typeof payload.ctaUrl === "string" ? payload.ctaUrl : defaultState.ctaUrl,
    footnote:
      typeof payload.footnote === "string" ? payload.footnote : defaultState.footnote,
    brandName:
      typeof payload.brandName === "string"
        ? payload.brandName
        : defaultState.brandName,
  }
}

export default function SettingsMailPage() {
  const { user, isAdmin } = useUser()
  const { t } = useTranslation()
  const [templates, setTemplates] = React.useState<MailTemplate[]>([])
  const [loadingTemplates, setLoadingTemplates] = React.useState(true)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewHtml, setPreviewHtml] = React.useState("")
  const [editorPreviewTemplate, setEditorPreviewTemplate] = React.useState<EditorPreviewTemplate>("content")
  const [editingBuiltInName, setEditingBuiltInName] = React.useState<string | null>(null)
  const [builtinPreviews, setBuiltinPreviews] = React.useState<BuiltinTemplatePreview[]>([])
  const [loadingBuiltinPreviews, setLoadingBuiltinPreviews] = React.useState(true)
  const [editor, setEditor] = React.useState<TemplateEditorState>(() =>
    createDefaultEditorState(t),
  )
  const [pendingDeleteTemplate, setPendingDeleteTemplate] =
    React.useState<MailTemplate | null>(null)
  const [deletingTemplate, setDeletingTemplate] = React.useState(false)
  // Row-expansion state for the new list-style layout. Built-ins and saved
  // templates each get their own set since they live in separate tables.
  const [expandedBuiltinIds, setExpandedBuiltinIds] = React.useState<
    Set<string>
  >(new Set())
  const [expandedSavedIds, setExpandedSavedIds] = React.useState<Set<string>>(
    new Set(),
  )
  // The View dialog shows an iframe preview. For built-ins the HTML is already
  // preloaded in builtinPreviews; for saved templates we fetch it on demand
  // and cache it here, mirroring how mail history fetches body_html lazily.
  type PreviewDialogState =
    | null
    | {
        title: string
        subtitle?: string
        status: "loading" | "ready" | "error"
        html?: string
        error?: string
      }
  const [previewDialog, setPreviewDialog] =
    React.useState<PreviewDialogState>(null)

  async function loadTemplates() {
    setLoadingTemplates(true)
    const supabase = createClient()
    const { data } = await supabase
      .from("mail_templates")
      .select("id, name, template_type, payload, is_active, created_by, created_at, updated_at")
      .order("updated_at", { ascending: false })

    setTemplates((data ?? []) as MailTemplate[])
    setLoadingTemplates(false)
  }

  React.useEffect(() => {
    void loadTemplates()
  }, [])

  React.useEffect(() => {
    let isCancelled = false

    async function loadBuiltinPreviews() {
      setLoadingBuiltinPreviews(true)

      const defaultState = createDefaultEditorState(t)
      const plainState = { ...defaultState, templateType: "plain" as const }
      const plainOsState = { ...defaultState, templateType: "plain_os" as const }
      const campaignState = { ...defaultState, templateType: "campaign" as const }

      const definitions: Array<{
        id: BuiltinTemplateType
        name: string
        template: "plain" | "content" | "campaign"
        payload: Record<string, unknown>
      }> = [
        {
          id: "plain",
          name: t("mail.send.optionPlain", "Plain"),
          template: "plain",
          payload: toTemplatePayload(plainState),
        },
        {
          id: "default",
          name: t("mail.send.optionDefault", "Default"),
          template: "content",
          payload: toTemplatePayload(defaultState),
        },
        {
          id: "plain_os",
          name: t("mail.send.optionPlainOs", "Plain OS"),
          template: "content",
          payload: toTemplatePayload(plainOsState),
        },
        {
          id: "campaign",
          name: t("mail.themes.campaign", "Campaign"),
          template: "campaign",
          payload: toTemplatePayload(campaignState),
        },
      ]

      const previews = await Promise.all(
        definitions.map(async (definition) => {
          try {
            const response = await fetch("/api/email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: ["preview@example.com"],
                template: definition.template,
                mode: "preview",
                data: definition.payload,
              }),
            })

            const result = (await response.json()) as { html?: string }
            return {
              id: definition.id,
              name: definition.name,
              html: response.ok ? (result.html ?? "") : "",
            }
          } catch {
            return {
              id: definition.id,
              name: definition.name,
              html: "",
            }
          }
        }),
      )

      if (isCancelled) return
      setBuiltinPreviews(previews)
      setLoadingBuiltinPreviews(false)
    }

    void loadBuiltinPreviews()

    return () => {
      isCancelled = true
    }
  }, [t])

  React.useEffect(() => {
    if (!editorOpen) return
    const abortController = new AbortController()
    const timeout = window.setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const response = await fetch("/api/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: ["preview@example.com"],
            template: editorPreviewTemplate,
            mode: "preview",
            data: toTemplatePayload(editor),
          }),
          signal: abortController.signal,
        })

        const result = (await response.json()) as { html?: string }
        if (!response.ok) {
          setPreviewHtml("")
          return
        }

        setPreviewHtml(result.html ?? "")
      } catch {
        if (!abortController.signal.aborted) {
          setPreviewHtml("")
        }
      } finally {
        if (!abortController.signal.aborted) {
          setPreviewLoading(false)
        }
      }
    }, 280)

    return () => {
      abortController.abort()
      window.clearTimeout(timeout)
    }
  }, [editor, editorOpen, editorPreviewTemplate])

  function openCreateTemplate() {
    setEditor(createDefaultEditorState(t))
    setEditorPreviewTemplate("content")
    setEditingBuiltInName(null)
    setEditorOpen(true)
  }

  function openEditTemplate(template: MailTemplate) {
    setEditor(parseTemplatePayload(template, t))
    setEditorPreviewTemplate(
      template.template_type === "plain"
        ? "plain"
        : template.template_type === "campaign"
          ? "campaign"
          : "content",
    )
    setEditingBuiltInName(null)
    setEditorOpen(true)
  }

  function openBuiltInTemplate(templateId: BuiltinTemplateType, templateName: string) {
    if (templateId === "plain") {
      const next = { ...createDefaultEditorState(t), name: templateName, templateType: "plain" as const }
      setEditor(next)
      setEditorPreviewTemplate("plain")
      setEditingBuiltInName(templateName)
      setEditorOpen(true)
      return
    }

    if (templateId === "campaign") {
      const next = {
        ...createDefaultEditorState(t),
        name: templateName,
        templateType: "campaign" as const,
      }
      setEditor(next)
      setEditorPreviewTemplate("campaign")
      setEditingBuiltInName(templateName)
      setEditorOpen(true)
      return
    }

    const next = {
      ...createDefaultEditorState(t),
      name: templateName,
      templateType: templateId,
    }
    setEditor(next)
    setEditorPreviewTemplate("content")
    setEditingBuiltInName(templateName)
    setEditorOpen(true)
  }

  async function handleSaveTemplate() {
    if (!editor.name.trim()) {
      toast.error(t("settings.mailTemplates.toast.nameRequired", "Template name is required"))
      return
    }

    setSaving(true)
    const supabase = createClient()
    const payload = toTemplatePayload(editor)
    // Anything outside the four known types falls back to "default" so we
    // never violate the DB check constraint if the editor state somehow holds
    // a stale or unexpected string.
    const persistedTemplateType: MailTemplateType =
      editor.templateType === "plain" ||
      editor.templateType === "plain_os" ||
      editor.templateType === "campaign"
        ? editor.templateType
        : "default"

    if (editor.id) {
      const { error } = await supabase
        .from("mail_templates")
        .update({
          name: editor.name.trim(),
          template_type: persistedTemplateType,
          payload,
          is_active: editor.isActive,
        } as never)
        .eq("id", editor.id)

      if (error) {
        toast.error(
          `${t("settings.mailTemplates.toast.saveFailed", "Failed to save template")}: ${error.message}`,
        )
        setSaving(false)
        return
      }
    } else {
      if (!user?.id) {
        toast.error(t("settings.mailTemplates.toast.saveFailed", "Failed to save template"))
        setSaving(false)
        return
      }

      const { error } = await supabase
        .from("mail_templates")
        .insert({
          name: editor.name.trim(),
          template_type: persistedTemplateType,
          payload,
          is_active: editor.isActive,
          created_by: user.id,
        } as never)

      if (error) {
        toast.error(
          `${t("settings.mailTemplates.toast.saveFailed", "Failed to save template")}: ${error.message}`,
        )
        setSaving(false)
        return
      }
    }

    toast.success(t("settings.mailTemplates.toast.saved", "Template saved"))
    setSaving(false)
    setEditorOpen(false)
    setEditingBuiltInName(null)
    await loadTemplates()
  }

  async function handleConfirmDeleteTemplate() {
    if (!pendingDeleteTemplate) return
    setDeletingTemplate(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from("mail_templates")
        .delete()
        .eq("id", pendingDeleteTemplate.id)

      if (error) {
        toast.error(
          `${t("settings.mailTemplates.toast.deleteFailed", "Failed to delete template")}: ${error.message}`,
        )
        return
      }

      toast.success(t("settings.mailTemplates.toast.deleted", "Template deleted"))
      setPendingDeleteTemplate(null)
      await loadTemplates()
    } finally {
      setDeletingTemplate(false)
    }
  }

  function themeLabelFor(type: MailTemplateType): string {
    if (type === "plain") return t("mail.themes.plain", "Plain")
    if (type === "plain_os") return t("mail.themes.plainOs", "Plain OS")
    if (type === "campaign") return t("mail.themes.campaign", "Campaign")
    return t("mail.themes.default", "Default")
  }

  function toggleBuiltinExpanded(id: string) {
    setExpandedBuiltinIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSavedExpanded(id: string) {
    setExpandedSavedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function openBuiltinPreview(builtin: BuiltinTemplatePreview) {
    setPreviewDialog({
      title: builtin.name,
      subtitle: t("settings.mailTemplates.builtInBadge", "Built-in"),
      status: "ready",
      html: builtin.html,
    })
  }

  // Saved templates don't ship with rendered HTML — fetch /api/email in
  // preview mode on demand, same approach as the editor's live preview.
  async function openSavedPreview(template: MailTemplate) {
    setPreviewDialog({
      title: template.name,
      subtitle: themeLabelFor(template.template_type),
      status: "loading",
    })

    const apiTemplate =
      template.template_type === "plain"
        ? "plain"
        : template.template_type === "campaign"
          ? "campaign"
          : "content"

    try {
      const response = await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: ["preview@example.com"],
          template: apiTemplate,
          mode: "preview",
          data: template.payload ?? {},
        }),
      })

      const result = (await response.json()) as { html?: string }
      if (!response.ok) {
        setPreviewDialog((current) =>
          current
            ? {
                ...current,
                status: "error",
                error: t(
                  "settings.mailTemplates.preview.loadFailed",
                  "Failed to load preview",
                ),
              }
            : current,
        )
        return
      }

      setPreviewDialog((current) =>
        current
          ? { ...current, status: "ready", html: result.html ?? "" }
          : current,
      )
    } catch {
      setPreviewDialog((current) =>
        current
          ? {
              ...current,
              status: "error",
              error: t(
                "settings.mailTemplates.preview.loadFailed",
                "Failed to load preview",
              ),
            }
          : current,
      )
    }
  }

  if (!isAdmin) {
    return <div className="h-40 rounded-lg border bg-muted/20" />
  }

  return (
    <div className="space-y-6">
      {!editorOpen ? (
        <>
          <div>
            <h3 className="text-base font-semibold">
              {t("settings.mailTemplates.existing", "Existing templates")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t(
                "settings.mailTemplates.existingDescription",
                "Templates available to users when sending emails.",
              )}
            </p>
          </div>

          {/* Built-in layouts as a list with expandable rows */}
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">
                {t("settings.mailTemplates.builtIn", "Built-in layouts")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  "settings.mailTemplates.builtInDescription",
                  "Default layouts available in Send mail.",
                )}
              </p>
            </div>

            {loadingBuiltinPreviews ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-12 w-full rounded-md" />
                ))}
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>
                        {t("settings.mailTemplates.list.layout", "Layout")}
                      </TableHead>
                      <TableHead className="w-[140px] text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {builtinPreviews.map((builtin) => {
                      const themeLabel = themeLabelFor(builtin.id)
                      const expanded = expandedBuiltinIds.has(builtin.id)
                      return (
                        <React.Fragment key={builtin.id}>
                          <TableRow
                            className="cursor-pointer"
                            onClick={() => toggleBuiltinExpanded(builtin.id)}
                          >
                            <TableCell className="w-10 text-muted-foreground">
                              <div className="flex items-center justify-center">
                                <ChevronDown
                                  className={cn(
                                    "size-4 transition-transform",
                                    expanded && "rotate-180",
                                  )}
                                />
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{themeLabel}</span>
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] uppercase"
                                >
                                  {t(
                                    "settings.mailTemplates.builtInBadge",
                                    "Built-in",
                                  )}
                                </Badge>
                              </div>
                            </TableCell>
                            <TableCell className="w-[140px] text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  openBuiltInTemplate(builtin.id, builtin.name)
                                }}
                              >
                                {t(
                                  "settings.mailTemplates.useTemplate",
                                  "Use layout",
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>

                          {expanded ? (
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableCell />
                              <TableCell colSpan={2} className="whitespace-normal">
                                <div className="flex items-center justify-between gap-3 py-1">
                                  <p className="text-xs text-muted-foreground">
                                    {t(
                                      "settings.mailTemplates.list.builtInExpandedHint",
                                      "Open a full preview, or use this layout to start a new template.",
                                    )}
                                  </p>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      openBuiltinPreview(builtin)
                                    }}
                                  >
                                    <Eye className="size-3.5" />
                                    {t(
                                      "settings.mailTemplates.list.view",
                                      "View",
                                    )}
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </React.Fragment>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Create button sits between built-ins and the saved list */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">
                {t(
                  "settings.mailTemplates.savedHeader",
                  "Saved templates",
                )}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  "settings.mailTemplates.savedDescription",
                  "Custom templates you've saved.",
                )}
              </p>
            </div>
            <Button onClick={openCreateTemplate}>
              <Plus className="size-4" />
              {t("settings.mailTemplates.create", "Create new template")}
            </Button>
          </div>

          {/* Saved templates as a list with expandable rows */}
          {loadingTemplates ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : templates.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-sm text-muted-foreground">
                {t("settings.mailTemplates.empty", "No templates yet. Create your first template.")}
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>
                      {t("settings.mailTemplates.list.name", "Name")}
                    </TableHead>
                    <TableHead className="w-[140px]">
                      {t("settings.mailTemplates.list.layout", "Layout")}
                    </TableHead>
                    <TableHead className="w-[110px]">
                      {t("settings.mailTemplates.list.status", "Status")}
                    </TableHead>
                    <TableHead className="w-[200px] text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.map((template) => {
                    const expanded = expandedSavedIds.has(template.id)
                    return (
                      <React.Fragment key={template.id}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggleSavedExpanded(template.id)}
                        >
                          <TableCell className="w-10 text-muted-foreground">
                            <div className="flex items-center justify-center">
                              <ChevronDown
                                className={cn(
                                  "size-4 transition-transform",
                                  expanded && "rotate-180",
                                )}
                              />
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">
                            {template.name}
                          </TableCell>
                          <TableCell className="w-[140px] text-muted-foreground">
                            {themeLabelFor(template.template_type)}
                          </TableCell>
                          <TableCell className="w-[110px] text-muted-foreground">
                            {template.is_active
                              ? t("settings.mailTemplates.active", "Active")
                              : t("settings.mailTemplates.inactive", "Inactive")}
                          </TableCell>
                          <TableCell className="w-[200px] text-right">
                            <div
                              className="flex items-center justify-end gap-2"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openEditTemplate(template)}
                              >
                                <Pencil className="size-3.5" />
                                {t("settings.mailTemplates.edit", "Edit")}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() =>
                                  setPendingDeleteTemplate(template)
                                }
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>

                        {expanded ? (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={4} className="whitespace-normal">
                              <div className="flex items-center justify-between gap-3 py-1">
                                <p className="text-xs text-muted-foreground">
                                  {t(
                                    "settings.mailTemplates.list.savedExpandedHint",
                                    "Open a full preview to see how this template renders.",
                                  )}
                                </p>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void openSavedPreview(template)
                                  }}
                                >
                                  <Eye className="size-3.5" />
                                  {t(
                                    "settings.mailTemplates.list.view",
                                    "View",
                                  )}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </React.Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
        
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.05fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {editor.id
                  ? t("settings.mailTemplates.editTemplate", "Edit template")
                  : t("settings.mailTemplates.createTemplate", "Create template")}
              </CardTitle>
              <CardDescription>
                {editingBuiltInName
                  ? t(
                      "settings.mailTemplates.editingBuiltIn",
                      `Editing built-in draft: ${editingBuiltInName}`,
                    )
                  : null}
                {editingBuiltInName ? <br /> : null}
                {t(
                  "settings.mailTemplates.editorDescription",
                  "Saved templates are available in the Mail send view.",
                )}
                <br />
                {t(
                  "settings.mailTemplates.dynamicTokensHelp",
                  "Use @customer and @company to create dynamic parts in the mail.",
                )}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="template-name">
                  {t("settings.mailTemplates.templateName", "Template name")}
                </Label>
                <Input
                  id="template-name"
                  value={editor.name}
                  onChange={(event) =>
                    setEditor((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">
                    {t("settings.mailTemplates.active", "Active")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "settings.mailTemplates.activeDescription",
                      "Only active templates are shown in the Mail send view.",
                    )}
                  </p>
                </div>
                <Switch
                  checked={editor.isActive}
                  onCheckedChange={(checked) =>
                    setEditor((current) => ({ ...current, isActive: checked }))
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="template-subject">{t("settings.mail.subject", "Subject")}</Label>
                <Input
                  id="template-subject"
                  value={editor.subject}
                  onChange={(event) =>
                    setEditor((current) => ({ ...current, subject: event.target.value }))
                  }
                />
              </div>

              {editor.templateType === "plain" ? (
                <div className="space-y-2">
                  <Label htmlFor="template-body">{t("mail.send.body", "Body")}</Label>
                  <Textarea
                    id="template-body"
                    className="min-h-40"
                    value={editor.body}
                    onChange={(event) =>
                      setEditor((current) => ({ ...current, body: event.target.value }))
                    }
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="template-title">{t("settings.mail.emailTitle", "Title")}</Label>
                    <Input
                      id="template-title"
                      value={editor.title}
                      onChange={(event) =>
                        setEditor((current) => ({ ...current, title: event.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="template-preview-text">
                      {t("settings.mail.previewText", "Preview text")}
                    </Label>
                    <Input
                      id="template-preview-text"
                      value={editor.previewText}
                      onChange={(event) =>
                        setEditor((current) => ({ ...current, previewText: event.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="template-greeting">{t("settings.mail.greeting", "Greeting")}</Label>
                    <Input
                      id="template-greeting"
                      value={editor.greeting}
                      onChange={(event) =>
                        setEditor((current) => ({ ...current, greeting: event.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="template-paragraphs">
                      {t("settings.mail.contentParagraphs", "Content paragraphs (separate paragraphs with an empty line)")}
                    </Label>
                    <Textarea
                      id="template-paragraphs"
                      className="min-h-36"
                      value={editor.paragraphs}
                      onChange={(event) =>
                        setEditor((current) => ({ ...current, paragraphs: event.target.value }))
                      }
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="template-cta-label">{t("settings.mail.ctaLabel", "CTA label")}</Label>
                      <Input
                        id="template-cta-label"
                        value={editor.ctaLabel}
                        onChange={(event) =>
                          setEditor((current) => ({ ...current, ctaLabel: event.target.value }))
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="template-cta-url">{t("settings.mail.ctaUrl", "CTA URL")}</Label>
                      <Input
                        id="template-cta-url"
                        value={editor.ctaUrl}
                        onChange={(event) =>
                          setEditor((current) => ({ ...current, ctaUrl: event.target.value }))
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="template-footnote">{t("settings.mail.footnote", "Footnote")}</Label>
                    <Textarea
                      id="template-footnote"
                      className="min-h-20"
                      value={editor.footnote}
                      onChange={(event) =>
                        setEditor((current) => ({ ...current, footnote: event.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="template-brand">{t("settings.mail.brandName", "Brand name")}</Label>
                    <Input
                      id="template-brand"
                      value={editor.brandName}
                      onChange={(event) =>
                        setEditor((current) => ({ ...current, brandName: event.target.value }))
                      }
                    />
                  </div>
                </>
              )}

              <div className="flex items-center gap-2">
                <Button onClick={handleSaveTemplate} disabled={saving || previewLoading}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  {editor.id
                    ? t("settings.mailTemplates.saveTemplate", "Save template")
                    : editingBuiltInName
                    ? t("settings.mailTemplates.saveAsNew", "Save as new template")
                    : t("settings.mailTemplates.saveTemplate", "Save template")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditorOpen(false)
                    setEditingBuiltInName(null)
                  }}
                >
                  <X className="size-4" />
                  {t("common.cancel", "Cancel")}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("settings.mail.previewTitle", "Rendered HTML preview")}
              </CardTitle>
              <CardDescription>
                {t("settings.mail.previewDescription", "Live server-rendered template output.")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {previewLoading ? (
                <div className="flex h-[875px] items-center justify-center rounded-md border bg-muted/20">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <iframe
                  title={t("settings.mail.previewIframeTitle", "Mail preview")}
                  className="h-[875px] w-full rounded-md border bg-white"
                  srcDoc={previewHtml}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog
        open={previewDialog !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewDialog(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              {previewDialog?.title ?? ""}
            </DialogTitle>
            {previewDialog?.subtitle ? (
              <DialogDescription>{previewDialog.subtitle}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="rounded-md border bg-white">
            {previewDialog?.status === "ready" ? (
              previewDialog.html && previewDialog.html.length > 0 ? (
                <iframe
                  title={previewDialog.title}
                  srcDoc={previewDialog.html}
                  className="h-[600px] w-full rounded-md"
                />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {t(
                    "settings.mailTemplates.preview.empty",
                    "No body content was rendered for this template.",
                  )}
                </p>
              )
            ) : previewDialog?.status === "error" ? (
              <p className="p-4 text-sm text-destructive">
                {previewDialog.error ??
                  t(
                    "settings.mailTemplates.preview.loadFailed",
                    "Failed to load preview",
                  )}
              </p>
            ) : (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDeleteTemplate !== null}
        onOpenChange={(open) => {
          if (!open && !deletingTemplate) setPendingDeleteTemplate(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                "settings.mailTemplates.delete.confirmTitle",
                "Delete this template?",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "settings.mailTemplates.delete.confirmDescription",
                "This permanently removes the template. Any saved drafts that referenced it will fall back to the built-in defaults.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDeleteTemplate ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="truncate font-medium">{pendingDeleteTemplate.name}</p>
              <p className="text-xs text-muted-foreground">
                {pendingDeleteTemplate.template_type === "plain"
                  ? t("mail.themes.plain", "Plain")
                  : pendingDeleteTemplate.template_type === "plain_os"
                    ? t("mail.themes.plainOs", "Plain OS")
                    : pendingDeleteTemplate.template_type === "campaign"
                      ? t("mail.themes.campaign", "Campaign")
                      : t("mail.themes.default", "Default")}
              </p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingTemplate}>
              {t("settings.mailTemplates.delete.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmDeleteTemplate()
              }}
              disabled={deletingTemplate}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingTemplate
                ? t("settings.mailTemplates.delete.confirming", "Deleting…")
                : t("settings.mailTemplates.delete.confirm", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
