"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowUp, GripVertical, Info, Loader2, MoreHorizontal, Paperclip, PanelLeftClose, PanelLeftOpen, Pin, Plus, Trash2, X } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type PickerOption = {
  id: string
  label: string
  subLabel?: string
}

type AskQuestionProps = {
  customers: PickerOption[]
  users: PickerOption[]
}

type AskQuestionResponse = {
  answer: string
  sources: Array<{ file_name: string; document_type: string | null; similarity: number }>
}

type AskQuestionErrorResponse = {
  error?: string
  [key: string]: unknown
}

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  attachments?: string[]
  sources?: Array<{ file_name: string; document_type: string | null; similarity: number }>
  // True for the optimistic "Thinking..." placeholder while we wait for
  // the LLM. Drives the pulse animation in the message list.
  isLoading?: boolean
}

type ConversationHistoryItem = {
  id: string
  title: string | null
  messages: ChatMessage[]
  updated_at: string
}

type ChatAttachment = {
  id: string
  name: string
  file: File
}

function getConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")
  const content = firstUserMessage?.content?.trim()
  if (!content) return "New conversation"

  return content.length > 80 ? `${content.slice(0, 77)}...` : content
}

function dedupeSourcesForDisplay(
  sources: Array<{ file_name: string; document_type: string | null; similarity: number }>,
): Array<{ file_name: string; document_type: string | null; similarity: number }> {
  const deduped = new Map<string, { file_name: string; document_type: string | null; similarity: number }>()

  for (const source of sources) {
    const key = source.file_name.trim().toLowerCase()
    const existing = deduped.get(key)

    if (!existing || source.similarity > existing.similarity) {
      deduped.set(key, source)
    }
  }

  return Array.from(deduped.values())
}

function getConversationOrderStorageKey(userId: string): string {
  return `dashboard.chat.conversation-order.${userId}`
}

function getConversationPinsStorageKey(userId: string): string {
  return `dashboard.chat.conversation-pins.${userId}`
}

function getMessagesSignature(value: ChatMessage[]): string {
  return JSON.stringify(value)
}

export function DashboardAskQuestion({ customers, users }: AskQuestionProps) {
  const { t, language } = useTranslation()
  const [question, setQuestion] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [userId, setUserId] = React.useState<string | null>(null)
  const [conversationId, setConversationId] = React.useState<string | null>(null)
  const [conversationHistory, setConversationHistory] = React.useState<ConversationHistoryItem[]>([])
  const [loadingConversation, setLoadingConversation] = React.useState(true)
  const [conversationDeleteTarget, setConversationDeleteTarget] = React.useState<ConversationHistoryItem | null>(null)
  const [deletingConversation, setDeletingConversation] = React.useState(false)
  const [conversationRenameTarget, setConversationRenameTarget] = React.useState<ConversationHistoryItem | null>(null)
  const [renameValue, setRenameValue] = React.useState("")
  const [renamingConversation, setRenamingConversation] = React.useState(false)
  const [historyCollapsed, setHistoryCollapsed] = React.useState(false)
  const [chatAttachments, setChatAttachments] = React.useState<ChatAttachment[]>([])
  const [conversationOrder, setConversationOrder] = React.useState<string[]>([])
  const [pinnedConversationIds, setPinnedConversationIds] = React.useState<string[]>([])
  const [draggingConversationId, setDraggingConversationId] = React.useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = React.useState<{
    conversationId: string
    placement: "before" | "after"
  } | null>(null)
  const hasMessages = messages.length > 0
  const persistTimerRef = React.useRef<number | null>(null)
  const conversationSignaturesRef = React.useRef<Record<string, string>>({})
  const isMountedRef = React.useRef(true)
  const messagesRef = React.useRef<ChatMessage[]>([])
  const conversationIdRef = React.useRef<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const messagesContainerRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  React.useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  const scrollMessagesToLatest = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const container = messagesContainerRef.current
    if (!container) return

    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    })
  }, [])

  const starterQuestions = React.useMemo(() => {
    if (language === "sv") {
      return [
        "Hur många fakturor skickades förra månaden?",
        "Vilka kunder har högst omsättning i år?",
        "Visa mig avtal som är aktiva just nu.",
      ]
    }

    return [
      "How many invoices were sent last month?",
      "Which customers have the highest turnover this year?",
      "Show me contracts that are active right now.",
    ]
  }, [language])

  // Empty-state hint shown beneath the input on a fresh chat. Explains what
  // the assistant currently has access to and what's still coming so users
  // don't waste a turn asking about data that isn't wired up yet.
  const chatContextHint = React.useMemo(() => {
    if (language === "sv") {
      return "Saldo OS Chat kan svara på frågor om CRM:et — kunder, fakturor, timmar, avtal, konsulter och KPI:er — samt interna dokument (t.ex. handboken). Ej anslutet ännu: SIE-filer och kundernas egna bokföringsunderlag."
    }
    return "Saldo OS Chat can answer questions about your CRM — customers, invoices, hours, contracts, consultants and KPIs — and your internal documents (e.g. handboken). Not yet connected: SIE files and customers' own bookkeeping records."
  }, [language])

  void customers
  void users

  const orderedConversationHistory = React.useMemo(() => {
    if (conversationHistory.length === 0) return []

    const mapById = new Map(conversationHistory.map((item) => [item.id, item]))
    const ordered: ConversationHistoryItem[] = []

    for (const id of conversationOrder) {
      const found = mapById.get(id)
      if (found) {
        ordered.push(found)
        mapById.delete(id)
      }
    }

    const remaining = Array.from(mapById.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const orderedWithRemaining = [...ordered, ...remaining]
    const pinnedSet = new Set(pinnedConversationIds)
    const pinned = orderedWithRemaining.filter((item) => pinnedSet.has(item.id))
    const unpinned = orderedWithRemaining.filter((item) => !pinnedSet.has(item.id))
    return [...pinned, ...unpinned]
  }, [conversationHistory, conversationOrder, pinnedConversationIds])

  React.useEffect(() => {
    let cancelled = false

    async function loadConversation() {
      const supabase = createClient()
      const { data: authData } = await supabase.auth.getUser()
      const authUserId = authData.user?.id ?? null

      if (cancelled) return

      if (!authUserId) {
        setLoadingConversation(false)
        return
      }

      setUserId(authUserId)

      const { data } = await supabase
        .from("conversations")
        .select("id, title, messages, updated_at")
        .eq("user_id", authUserId)
        .order("updated_at", { ascending: false })
        .limit(20)

      if (cancelled) return

      const history = ((data ?? []) as Array<{
        id: string
        title: string | null
        messages: unknown
        updated_at: string
      }>).map((row) => ({
        id: row.id,
        title: row.title,
        messages: Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [],
        updated_at: row.updated_at,
      }))

      const signatures: Record<string, string> = {}
      for (const item of history) {
        signatures[item.id] = getMessagesSignature(item.messages)
      }
      conversationSignaturesRef.current = signatures

      const orderStorageKey = getConversationOrderStorageKey(authUserId)
      const pinsStorageKey = getConversationPinsStorageKey(authUserId)
      const savedOrderRaw = localStorage.getItem(orderStorageKey)
      const savedPinsRaw = localStorage.getItem(pinsStorageKey)
      let savedOrder: string[] = []
      let savedPins: string[] = []
      if (savedOrderRaw) {
        try {
          const parsed = JSON.parse(savedOrderRaw)
          if (Array.isArray(parsed)) {
            savedOrder = parsed.filter((value): value is string => typeof value === "string")
          }
        } catch {
          savedOrder = []
        }
      }

      if (savedPinsRaw) {
        try {
          const parsed = JSON.parse(savedPinsRaw)
          if (Array.isArray(parsed)) {
            savedPins = parsed.filter((value): value is string => typeof value === "string")
          }
        } catch {
          savedPins = []
        }
      }

      const historyIds = history.map((item) => item.id)
      const sanitizedSavedOrder = savedOrder.filter((id) => historyIds.includes(id))
      const sanitizedSavedPins = savedPins.filter((id) => historyIds.includes(id))
      const missingIds = historyIds.filter((id) => !sanitizedSavedOrder.includes(id))
      const nextOrder = [...sanitizedSavedOrder, ...missingIds]

      setConversationOrder(nextOrder)
      setPinnedConversationIds(sanitizedSavedPins)
      localStorage.setItem(orderStorageKey, JSON.stringify(nextOrder))
      localStorage.setItem(pinsStorageKey, JSON.stringify(sanitizedSavedPins))

      setConversationHistory(history)

      setLoadingConversation(false)
    }

    void loadConversation()

    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!userId) return
    localStorage.setItem(getConversationOrderStorageKey(userId), JSON.stringify(conversationOrder))
  }, [conversationOrder, userId])

  React.useEffect(() => {
    if (!userId) return
    localStorage.setItem(getConversationPinsStorageKey(userId), JSON.stringify(pinnedConversationIds))
  }, [pinnedConversationIds, userId])

  React.useEffect(() => {
    if (!hasMessages) return

    const frameId = window.requestAnimationFrame(() => {
      scrollMessagesToLatest("auto")
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [conversationId, hasMessages, messages.length, scrollMessagesToLatest])

  const persistConversation = React.useCallback(
    async (nextMessages: ChatMessage[]): Promise<string | null> => {
      if (!userId || nextMessages.length === 0) {
        return null
      }

      const nextSignature = getMessagesSignature(nextMessages)

      if (conversationId) {
        const previousSignature = conversationSignaturesRef.current[conversationId]
        if (previousSignature === nextSignature) {
          return conversationId
        }
      }

      const supabase = createClient()
      const title = getConversationTitle(nextMessages)

      if (!conversationId) {
        const { data } = await supabase
          .from("conversations")
          .insert({
            user_id: userId,
            title,
            messages: nextMessages as unknown as Record<string, unknown>[],
          } as never)
          .select("id, title, messages, updated_at")
          .single()

        if (!data) return null

        const inserted = data as {
          id: string
          title: string | null
          messages: unknown
          updated_at: string
        }

        conversationSignaturesRef.current[inserted.id] = nextSignature

        setConversationId(inserted.id)
        setConversationHistory((current) => [
          {
            id: inserted.id,
            title: inserted.title,
            messages: Array.isArray(inserted.messages) ? (inserted.messages as ChatMessage[]) : nextMessages,
            updated_at: inserted.updated_at,
          },
          ...current,
        ])
        setConversationOrder((current) => [inserted.id, ...current.filter((id) => id !== inserted.id)])
        return inserted.id
      }

      const { data } = await supabase
        .from("conversations")
        .update({
          title,
          messages: nextMessages as unknown as Record<string, unknown>[],
        } as never)
        .eq("id", conversationId)
        .select("id, title, messages, updated_at")
        .single()

      if (!data) return null

      const updated = data as {
        id: string
        title: string | null
        messages: unknown
        updated_at: string
      }

      conversationSignaturesRef.current[updated.id] = nextSignature

      setConversationHistory((current) => {
        return current.map((item) =>
          item.id === updated.id
            ? {
                ...item,
                title: updated.title,
                messages: Array.isArray(updated.messages)
                  ? (updated.messages as ChatMessage[])
                  : nextMessages,
                updated_at: updated.updated_at,
              }
            : item,
        )
      })
      setConversationOrder((current) => [updated.id, ...current.filter((id) => id !== updated.id)])
      return updated.id
    },
    [conversationId, userId],
  )

  React.useEffect(() => {
    if (loadingConversation) return

    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current)
    }

    persistTimerRef.current = window.setTimeout(() => {
      void persistConversation(messages)
    }, 250)

    return () => {
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current)
      }
    }
  }, [loadingConversation, messages, persistConversation])

  function handleConversationSwitch(nextConversationId: string) {
    const selectedConversation = conversationHistory.find(
      (conversation) => conversation.id === nextConversationId,
    )
    if (!selectedConversation) return

    setConversationId(selectedConversation.id)
    setMessages(selectedConversation.messages)
    setChatAttachments([])
  }

  function handleStartNewConversation() {
    setConversationId(null)
    setMessages([])
    setQuestion("")
    setChatAttachments([])
  }

  function reorderConversations(draggedId: string, targetId: string, placement: "before" | "after") {
    if (draggedId === targetId) return

    setConversationOrder((current) => {
      const withMissing = [
        ...current,
        ...orderedConversationHistory
          .map((conversation) => conversation.id)
          .filter((id) => !current.includes(id)),
      ]
      const withoutDragged = withMissing.filter((id) => id !== draggedId)
      const targetIndex = withoutDragged.indexOf(targetId)

      if (targetIndex === -1) {
        return [draggedId, ...withoutDragged]
      }

      const insertIndex = placement === "after" ? targetIndex + 1 : targetIndex

      return [
        ...withoutDragged.slice(0, insertIndex),
        draggedId,
        ...withoutDragged.slice(insertIndex),
      ]
    })
  }

  async function handleRenameConversation(target: ConversationHistoryItem) {
    const nextTitle = renameValue.trim()
    if (!nextTitle || nextTitle === target.title) {
      setConversationRenameTarget(null)
      setRenameValue("")
      return
    }

    setRenamingConversation(true)
    const supabase = createClient()
    const { data } = await supabase
      .from("conversations")
      .update({ title: nextTitle } as never)
      .eq("id", target.id)
      .select("id, title, updated_at")
      .single()

    if (!data) {
      setRenamingConversation(false)
      return
    }

    setConversationHistory((current) =>
      current.map((item) =>
        item.id === target.id
          ? {
              ...item,
              title: (data as { title: string | null }).title,
              updated_at: (data as { updated_at: string }).updated_at,
            }
          : item,
      ),
    )

    setRenamingConversation(false)
    setConversationRenameTarget(null)
    setRenameValue("")
  }

  async function handleDeleteConversation(target: ConversationHistoryItem) {
    setDeletingConversation(true)
    const supabase = createClient()
    const { error } = await supabase.from("conversations").delete().eq("id", target.id)
    if (error) {
      setDeletingConversation(false)
      return
    }

    setConversationHistory((current) => current.filter((item) => item.id !== target.id))
    setConversationOrder((current) => current.filter((id) => id !== target.id))
    setPinnedConversationIds((current) => current.filter((id) => id !== target.id))
    delete conversationSignaturesRef.current[target.id]
    setConversationDeleteTarget(null)
    setDeletingConversation(false)

    if (conversationId === target.id) {
      const next = orderedConversationHistory.find((item) => item.id !== target.id)
      if (next) {
        setConversationId(next.id)
        setMessages(next.messages)
      } else {
        handleStartNewConversation()
      }
    }
  }

  async function submitQuestion(questionOverride?: string) {
    const trimmedQuestion = (questionOverride ?? question).trim()
    if (!trimmedQuestion) return

    const attachmentNames = chatAttachments.map((attachment) => attachment.name)

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion,
      attachments: attachmentNames.length > 0 ? attachmentNames : undefined,
    }
    const assistantMessageId = crypto.randomUUID()

    const optimisticMessages: ChatMessage[] = [
      ...messagesRef.current,
      userMessage,
      {
        id: assistantMessageId,
        role: "assistant",
        content: t("dashboard.ask.thinking", "Thinking..."),
        isLoading: true,
      },
    ]
    setMessages(optimisticMessages)
    if (!questionOverride) {
      setQuestion("")
    }
    setChatAttachments([])
    setLoading(true)
    let activeConversationId = conversationIdRef.current

    try {
      void persistConversation(optimisticMessages)
        .then((persistedConversationId) => {
          activeConversationId = persistedConversationId ?? activeConversationId
        })
        .catch(() => {
          // Best-effort persistence before request; continue so chat response is
          // still attempted even if conversation pre-save fails.
        })

      // Cap the wait at 75s — slightly longer than the server's 60s
      // maxDuration so we still surface the server's own timeout message if
      // it fires first, but we never let the spinner hang forever.
      const abortController = new AbortController()
      const abortTimer = window.setTimeout(() => {
        abortController.abort()
      }, 75_000)

      let response: Response
      try {
        response = await (async () => {
          if (chatAttachments.length === 0) {
            return fetch("/api/chat", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                question: trimmedQuestion,
                conversation_id: activeConversationId,
              }),
              signal: abortController.signal,
            })
          }

          const formData = new FormData()
          formData.append("question", trimmedQuestion)
          for (const attachment of chatAttachments) {
            formData.append("files", attachment.file, attachment.file.name)
          }

          return fetch("/api/questions/ask-documents", {
            method: "POST",
            body: formData,
            signal: abortController.signal,
          })
        })()
      } finally {
        window.clearTimeout(abortTimer)
      }

      const data = (await response.json()) as AskQuestionResponse | AskQuestionErrorResponse
      if (!response.ok) {
        const message =
          "error" in data
            ? (data.error ?? t("dashboard.ask.failed", "Failed to ask question"))
            : t("dashboard.ask.failed", "Failed to ask question")
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  content: message,
                  isLoading: false,
                }
              : item
          )
        )
        return
      }

      const successPayload = data as AskQuestionResponse
      const resolvedMessages = optimisticMessages.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: successPayload.answer,
                sources: successPayload.sources,
                isLoading: false,
              }
            : item,
        )
      if (isMountedRef.current) {
        setMessages(resolvedMessages)
      }
      if (activeConversationId) {
        const supabase = createClient()
        await supabase
          .from("conversations")
          .update({
            title: getConversationTitle(resolvedMessages),
            messages: resolvedMessages as unknown as Record<string, unknown>[],
          } as never)
          .eq("id", activeConversationId)
      }
    } catch (err) {
      const isAbort =
        err instanceof DOMException && err.name === "AbortError"
      const message = isAbort
        ? t(
            "dashboard.ask.timeout",
            "The request took too long and was cancelled. Try a more specific question.",
          )
        : t("dashboard.ask.failed", "Failed to ask question")
      const failedMessages = optimisticMessages.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: message,
                isLoading: false,
              }
            : item,
        )
      if (isMountedRef.current) {
        setMessages(failedMessages)
      }
      if (activeConversationId) {
        const supabase = createClient()
        await supabase
          .from("conversations")
          .update({
            title: getConversationTitle(failedMessages),
            messages: failedMessages as unknown as Record<string, unknown>[],
          } as never)
          .eq("id", activeConversationId)
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false)
      }
    }
  }

  function handleStarterQuestionClick(starterQuestion: string) {
    if (loading) return
    void submitQuestion(starterQuestion)
  }

  function handleAttachmentSelected(file: File) {
    setChatAttachments((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: file.name,
        file,
      },
    ])

    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  function handleAttachmentClick() {
    fileInputRef.current?.click()
  }

  function handleAttachmentRemove(attachmentId: string) {
    setChatAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }

  function handleTogglePinConversation(conversationIdToToggle: string) {
    setPinnedConversationIds((current) =>
      current.includes(conversationIdToToggle)
        ? current.filter((id) => id !== conversationIdToToggle)
        : [...current, conversationIdToToggle],
    )
  }

  return (
    <div className={cn(
      "grid h-full overflow-hidden",
      historyCollapsed ? "grid-cols-[52px_1fr]" : "grid-cols-[280px_1fr]",
    )}>
      <aside className="flex h-full flex-col border-r bg-muted/20 p-2">
        <Button
          variant="outline"
          className={cn("h-9 gap-2", historyCollapsed ? "justify-center px-0" : "justify-start")}
          onClick={handleStartNewConversation}
        >
          <Plus className="size-4" />
          {historyCollapsed ? null : t("dashboard.ask.newChat", "New chat")}
        </Button>

        <div className={cn("mt-3 flex-1 space-y-1 overflow-y-auto pr-1", historyCollapsed && "hidden")}>
          {orderedConversationHistory.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No saved conversations yet.</p>
          ) : (
            orderedConversationHistory.map((conversation) => {
              const isActive = conversation.id === conversationId
              const isPinned = pinnedConversationIds.includes(conversation.id)

              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group relative flex h-9 items-center rounded-md border px-2 transition-colors",
                    isActive ? "border-border bg-background" : "border-transparent hover:bg-background/70",
                    draggingConversationId === conversation.id && "opacity-60",
                  )}
                  draggable
                  onDragStart={() => setDraggingConversationId(conversation.id)}
                  onDragOver={(event) => {
                    event.preventDefault()
                    if (!draggingConversationId || draggingConversationId === conversation.id) {
                      setDropIndicator(null)
                      return
                    }

                    const { top, height } = event.currentTarget.getBoundingClientRect()
                    const placement = event.clientY - top < height / 2 ? "before" : "after"
                    setDropIndicator({
                      conversationId: conversation.id,
                      placement,
                    })
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDropIndicator((current) =>
                        current?.conversationId === conversation.id ? null : current,
                      )
                    }
                  }}
                  onDrop={() => {
                    if (!draggingConversationId) return
                    if (draggingConversationId === conversation.id) {
                      setDraggingConversationId(null)
                      setDropIndicator(null)
                      return
                    }
                    const placement =
                      dropIndicator?.conversationId === conversation.id
                        ? dropIndicator.placement
                        : "before"
                    reorderConversations(draggingConversationId, conversation.id, placement)
                    setDraggingConversationId(null)
                    setDropIndicator(null)
                  }}
                  onDragEnd={() => {
                    setDraggingConversationId(null)
                    setDropIndicator(null)
                  }}
                >
                  {dropIndicator?.conversationId === conversation.id && draggingConversationId ? (
                    <div
                      className={cn(
                        "pointer-events-none absolute left-2 right-2 h-0.5 rounded-full bg-primary",
                        dropIndicator.placement === "before" ? "-top-0.5" : "-bottom-0.5",
                      )}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="mr-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Drag conversation"
                  >
                    <GripVertical className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className={cn("min-w-0 flex-1 truncate text-left text-sm", isPinned && "pr-2")}
                    onClick={() => handleConversationSwitch(conversation.id)}
                  >
                    {conversation.title ?? "Untitled conversation"}
                  </button>
                  {isPinned ? <Pin className="mr-1 size-3 text-primary" /> : null}
                  <div className="ml-2 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label="Conversation options"
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleTogglePinConversation(conversation.id)}>
                          <Pin className="size-4" />
                          {isPinned ? "Unpin" : "Pin"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setConversationRenameTarget(conversation)
                            setRenameValue(conversation.title ?? "")
                          }}
                        >
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setConversationDeleteTarget(conversation)}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className={cn("mt-2 h-8", historyCollapsed ? "justify-center px-0" : "justify-start")}
          onClick={() => setHistoryCollapsed((current) => !current)}
        >
          {historyCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {historyCollapsed ? null : t("dashboard.ask.collapse", "Collapse")}
        </Button>
      </aside>

      <div className="relative h-full overflow-hidden bg-background">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) return
            handleAttachmentSelected(file)
          }}
        />

        <div
          ref={messagesContainerRef}
          className={cn(
          "h-full overflow-y-auto transition-all duration-500",
          hasMessages ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-36 pt-6">
            {messages.map((message) => (
              <div key={message.id} className={cn("flex w-full", message.role === "user" ? "justify-end" : "justify-start")}>
                {message.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl bg-foreground px-4 py-3 text-sm text-background md:max-w-[70%]">
                    <p>{message.content}</p>
                    {message.attachments && message.attachments.length > 0 ? (
                      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                        {message.attachments.map((attachmentName) => (
                          <span
                            key={`${message.id}-${attachmentName}`}
                            className="inline-flex max-w-56 items-center truncate rounded-full border border-background/20 px-2 py-0.5 text-xs text-background/90"
                          >
                            {attachmentName}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="max-w-[90%] md:max-w-[78%]">
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Saldo OS</p>
                    <div
                      className={cn(
                        "prose prose-sm prose-zinc dark:prose-invert max-w-none text-sm leading-relaxed text-foreground [&_p]:text-foreground [&_li]:text-foreground [&_strong]:text-foreground [&_em]:text-foreground [&_code]:text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_blockquote]:text-muted-foreground [&_a]:text-primary",
                        // Tables: react-markdown + remark-gfm renders them as
                        // bare <table>/<thead>/<tbody>/<tr>/<th>/<td>. The
                        // `prose` plugin styles tables only in non-compact
                        // mode, and we use prose-sm here, so we paint the
                        // borders, padding and colors ourselves.
                        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
                        "[&_thead]:border-b [&_thead]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-foreground",
                        "[&_tbody_tr]:border-b [&_tbody_tr]:border-border/60 [&_tbody_tr:last-child]:border-b-0",
                        "[&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_td]:text-foreground",
                        // While we wait for the LLM the placeholder text
                        // ("Thinking...") fades in and out so it visibly
                        // signals "we're working on it" instead of looking
                        // like a static, dead message.
                        message.isLoading &&
                          "animate-pulse text-muted-foreground [&_p]:text-muted-foreground",
                      )}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    </div>
                    {message.sources && message.sources.length > 0 && (
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        {dedupeSourcesForDisplay(message.sources).map((source, index) => (
                          <p key={`${message.id}-${source.file_name}-${source.document_type ?? "unknown"}-${index}`}>
                            {`Källa: ${source.file_name} (${Math.round(source.similarity * 100)}% match)`}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {!hasMessages && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-4">
            <div className="text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
                {t("dashboard.ask.heading", "What do you need insights on today?")}
              </h1>
              <div className="mt-4 flex flex-col items-center gap-2">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {starterQuestions.slice(0, 2).map((starterQuestion) => (
                    <button
                      key={starterQuestion}
                      type="button"
                      onClick={() => handleStarterQuestionClick(starterQuestion)}
                      disabled={loading}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-sm transition-colors",
                        loading
                          ? "cursor-not-allowed border-muted-foreground/30 text-muted-foreground/50"
                          : "border-border bg-background text-foreground hover:bg-muted",
                      )}
                    >
                      {starterQuestion}
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleStarterQuestionClick(starterQuestions[2])}
                    disabled={loading}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-sm transition-colors",
                      loading
                        ? "cursor-not-allowed border-muted-foreground/30 text-muted-foreground/50"
                        : "border-border bg-background text-foreground hover:bg-muted",
                    )}
                  >
                    {starterQuestions[2]}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex w-full max-w-[600px] flex-col items-stretch gap-2.5">
            <form
              onSubmit={(e) => { e.preventDefault(); void submitQuestion() }}
              className="w-full rounded-2xl border bg-background p-2 shadow-sm"
            >
              {chatAttachments.length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                  {chatAttachments.map((attachment) => (
                    <span
                      key={attachment.id}
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
                    >
                      <span className="max-w-56 truncate">{attachment.name}</span>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => handleAttachmentRemove(attachment.id)}
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="relative">
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={t("dashboard.ask.servicesPlaceholder", "Ask about our services...")}
                  className="h-12 rounded-xl border-0 bg-transparent pl-12 pr-12 text-sm shadow-none focus-visible:ring-0"
                />
                <button
                  type="button"
                  onClick={handleAttachmentClick}
                  disabled={loading}
                  className={cn(
                    "absolute left-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border transition-colors",
                    loading
                      ? "cursor-not-allowed border-muted-foreground/30 text-muted-foreground/50"
                      : "border-border text-foreground hover:bg-muted"
                  )}
                >
                  <Paperclip className="size-4" />
                </button>
                <button
                  type="submit"
                  disabled={loading || question.trim().length === 0}
                  className={cn(
                    "absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border transition-colors",
                    loading || question.trim().length === 0
                      ? "cursor-not-allowed border-muted-foreground/30 text-muted-foreground/50"
                      : "border-border text-foreground hover:bg-muted"
                  )}
                >
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                </button>
              </div>
            </form>
              <div className="flex items-start gap-1.5 rounded-md border border-border/40 bg-muted/30 px-3 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <p className="text-left">{chatContextHint}</p>
              </div>
            </div>
          </div>
        )}

        {hasMessages && (
          <div className="absolute bottom-6 left-1/2 z-20 w-[min(700px,calc(100%-2rem))] -translate-x-1/2">
            <form
              onSubmit={(e) => { e.preventDefault(); void submitQuestion() }}
              className="rounded-2xl border bg-background p-2 shadow-sm"
            >
              {chatAttachments.length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                  {chatAttachments.map((attachment) => (
                    <span
                      key={attachment.id}
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
                    >
                      <span className="max-w-56 truncate">{attachment.name}</span>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => handleAttachmentRemove(attachment.id)}
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="relative">
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={t("dashboard.ask.servicesPlaceholder", "Ask about our services...")}
                  className="h-12 rounded-xl border-0 bg-transparent pl-12 pr-12 text-sm shadow-none focus-visible:ring-0"
                />
                <button
                  type="button"
                  onClick={handleAttachmentClick}
                  disabled={loading}
                  className={cn(
                    "absolute left-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border transition-colors",
                    loading
                      ? "cursor-not-allowed border-muted-foreground/30 text-muted-foreground/50"
                      : "border-border text-foreground hover:bg-muted"
                  )}
                >
                  <Paperclip className="size-4" />
                </button>
                <button
                  type="submit"
                  disabled={loading || question.trim().length === 0}
                  className={cn(
                    "absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border transition-colors",
                    loading || question.trim().length === 0
                      ? "cursor-not-allowed border-muted-foreground/30 text-muted-foreground/50"
                      : "border-border text-foreground hover:bg-muted"
                  )}
                >
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                </button>
              </div>
            </form>
          </div>
        )}

        {loadingConversation ? (
          <div className="absolute right-4 top-4 text-xs text-muted-foreground">
            Loading chat history...
          </div>
        ) : null}

        <Dialog
          open={!!conversationRenameTarget}
          onOpenChange={(open) => {
            if (!open) {
              setConversationRenameTarget(null)
              setRenameValue("")
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription>Choose a clearer title for this chat.</DialogDescription>
            </DialogHeader>
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="Conversation title"
              autoFocus
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setConversationRenameTarget(null)
                  setRenameValue("")
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!conversationRenameTarget) return
                  await handleRenameConversation(conversationRenameTarget)
                }}
                disabled={renamingConversation || renameValue.trim().length === 0}
              >
                {renamingConversation ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={!!conversationDeleteTarget}
          onOpenChange={(open) => {
            if (!open) {
              setConversationDeleteTarget(null)
            }
          }}
          title="Delete conversation"
          description={conversationDeleteTarget ? `Permanently delete "${conversationDeleteTarget.title ?? "Untitled conversation"}"?` : "Permanently delete conversation?"}
          confirmLabel="Delete"
          variant="destructive"
          loading={deletingConversation}
          onConfirm={async () => {
            if (!conversationDeleteTarget) return
            await handleDeleteConversation(conversationDeleteTarget)
          }}
        />
      </div>
    </div>
  )
}
