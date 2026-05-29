"use client"

import { Search, Sparkles } from "lucide-react"
import { motion } from "framer-motion"

export type QueryMode = "search" | "ask"

interface ModeToggleProps {
  mode: QueryMode
  onChange: (mode: QueryMode) => void
}

const MODES: { value: QueryMode; label: string; icon: typeof Search; hint: string }[] = [
  { value: "search", label: "Search", icon: Search, hint: "Browse matching tiles" },
  { value: "ask", label: "Ask", icon: Sparkles, hint: "Get a synthesized answer" },
]

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 p-1 backdrop-blur-sm">
      {MODES.map(({ value, label, icon: Icon }) => {
        const active = mode === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            className={`relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {active && (
              <motion.span
                layoutId="mode-pill"
                className="absolute inset-0 rounded-full bg-primary"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            <Icon className="relative z-10 h-3.5 w-3.5" />
            <span className="relative z-10">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
