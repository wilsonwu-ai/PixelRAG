"use client"

import { Camera, Boxes, Database, Server, ArrowRight } from "lucide-react"

const PIPELINE = [
  { icon: Camera, label: "Render", desc: "Documents → screenshot tiles (Playwright CDP, PDF)" },
  { icon: Boxes, label: "Embed", desc: "Tiles → vectors via Qwen3-VL-Embedding" },
  { icon: Database, label: "Index", desc: "Vectors → FAISS IVF index at scale" },
  { icon: Server, label: "Serve", desc: "FastAPI search over pixels — text or image queries" },
]

const STATS = [
  { value: "8.28M", label: "Wikipedia articles" },
  { value: "28.1M", label: "screenshot tiles" },
  { value: "2048", label: "embedding dim" },
  { value: "214 GB", label: "FAISS index" },
]

export function AboutSection() {
  return (
    <section className="relative mx-auto max-w-5xl px-6 pb-28 pt-16">
      {/* Why */}
      <div className="mx-auto max-w-2xl text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary/70">
          Why pixels
        </p>
        <h2 className="mt-3 font-display text-3xl font-light leading-tight tracking-tight sm:text-4xl">
          Documents are visual. <span className="text-muted-foreground">Retrieval should be too.</span>
        </h2>
        <p className="mx-auto mt-4 text-[15px] leading-relaxed text-muted-foreground">
          Text extraction throws away layout, tables, figures, and styling —
          the very signals that make a page legible. PixelRAG embeds a{" "}
          <span className="text-foreground">screenshot of the page</span> instead,
          so a single vision model retrieves across text and visual content
          alike. No OCR, no parsing, no lossy chunking.
        </p>
      </div>

      {/* Pipeline */}
      <div className="mt-16">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:gap-0">
          {PIPELINE.map((step, i) => (
            <div key={step.label} className="relative flex sm:block">
              <div className="group flex-1 rounded-2xl border border-border bg-card/50 p-5 transition-colors hover:border-primary/30 hover:bg-card sm:mx-1.5">
                <step.icon className="h-5 w-5 text-primary" strokeWidth={1.5} />
                <h3 className="mt-3 font-display text-lg font-medium">{step.label}</h3>
                <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
                  {step.desc}
                </p>
              </div>
              {i < PIPELINE.length - 1 && (
                <div className="hidden items-center justify-center sm:flex sm:absolute sm:-right-2 sm:top-1/2 sm:-translate-y-1/2 sm:z-10">
                  <ArrowRight className="h-4 w-4 text-muted-foreground/40" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Scale */}
      <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-4">
        {STATS.map((s) => (
          <div key={s.label} className="bg-background px-6 py-7 text-center">
            <div className="font-display text-3xl font-light tabular-nums text-foreground">
              {s.value}
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* Footer note */}
      <p className="mt-12 text-center text-[13px] text-muted-foreground">
        Open source on{" "}
        <a
          href="https://github.com/StarTrail-org/PixelRAG"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline-offset-2 hover:underline"
        >
          GitHub
        </a>
      </p>
    </section>
  )
}
