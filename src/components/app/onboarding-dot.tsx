import { cn } from "@/lib/utils"

/**
 * Small pulsing green dot used next to card titles to flag the steps that need
 * attention while onboarding a customer.
 */
export function OnboardingDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("relative inline-flex size-2 shrink-0", className)}
      aria-hidden="true"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-semantic-success opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-semantic-success" />
    </span>
  )
}
