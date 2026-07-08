import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DevelopmentBadge } from "@/components/app/development-badge"
import { system } from "@/config/system"
import { LanguageProvider } from "@/hooks/use-language"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: system.name,
  description: system.description,
  icons: {
    icon: system.favicon,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <LanguageProvider>
          <TooltipProvider delayDuration={300}>
            {children}
            <DevelopmentBadge />
            <Toaster richColors closeButton position="bottom-right" />
          </TooltipProvider>
        </LanguageProvider>
      </body>
    </html>
  )
}
