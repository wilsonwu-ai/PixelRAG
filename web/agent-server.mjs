#!/usr/bin/env node
/**
 * PixelRAG Agent backend — standalone SSE server.
 *
 * Runs the Claude Agent SDK with subscription auth (uses the logged-in
 * `claude` CLI on this machine — no ANTHROPIC_API_KEY needed). Exposes the
 * same agent loop + pixelrag tools as the Next.js /api/chat route, so the
 * deployed Vercel frontend can proxy to it instead of running the SDK in
 * serverless (where the native CLI binary and credentials don't exist).
 *
 * Run on a machine where `claude` is logged in:
 *     node deploy/agent-server.mjs
 *
 * Env:
 *     AGENT_PORT          listen port (default 30010)
 *     PIXELRAG_SEARCH_URL search API base (default http://localhost:30001)
 *     CHAT_MAX_BUDGET_USD per-conversation budget cap (default 0.50)
 *     ALLOWED_ORIGIN      CORS origin (default *)
 */

import http from "node:http"
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

const PORT = parseInt(process.env.AGENT_PORT || "30010", 10)
const SEARCH_URL = process.env.PIXELRAG_SEARCH_URL || "http://localhost:30001"
const MAX_BUDGET = parseFloat(process.env.CHAT_MAX_BUDGET_USD || "2.00")
const THINKING_TOKENS = parseInt(process.env.CHAT_THINKING_TOKENS || "2000", 10)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"

// Rate limiting — protects the subscription on a public endpoint.
const RL_PER_IP = parseInt(process.env.RL_PER_IP || "8", 10)            // requests per IP per window
const RL_WINDOW_MS = parseInt(process.env.RL_WINDOW_MS || "3600000", 10) // 1 hour
const RL_GLOBAL_DAILY = parseInt(process.env.RL_GLOBAL_DAILY || "300", 10) // total/day, hard ceiling
const RL_MAX_CONCURRENT = parseInt(process.env.RL_MAX_CONCURRENT || "3", 10) // simultaneous conversations

const ipHits = new Map() // ip -> number[] (timestamps)
let dailyCount = 0
let dailyResetAt = 0
let inFlight = 0

function rateLimit(ip, now) {
  if (now >= dailyResetAt) { dailyCount = 0; dailyResetAt = now + 86400000 }
  if (dailyCount >= RL_GLOBAL_DAILY) return { ok: false, reason: "Daily limit reached — try again tomorrow." }
  if (inFlight >= RL_MAX_CONCURRENT) return { ok: false, reason: "Server busy — too many conversations at once. Try again shortly." }
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS)
  if (hits.length >= RL_PER_IP) return { ok: false, reason: "Rate limit reached — please wait a bit before asking again." }
  hits.push(now)
  ipHits.set(ip, hits)
  dailyCount++
  return { ok: true }
}

const SYSTEM_PROMPT = `You are a research assistant with access to a visual Wikipedia search engine (PixelRAG).

Workflow:
1. Use pixelrag_search to find relevant Wikipedia articles by query
2. Use pixelrag_tile to VIEW the actual screenshot tiles from top results — this is how you read the content
3. Synthesize an answer based on what you see in the tiles

Always view at least 2-3 tiles before answering. The tiles contain the actual Wikipedia content as rendered screenshots — read them carefully. Cite your sources with Wikipedia URLs.

If search results are insufficient, say so honestly rather than guessing.`

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function createTools(onEvent) {
  const searchTool = tool(
    "pixelrag_search",
    "Search the visual Wikipedia index. Returns ranked results with article URLs and tile positions. Use this first to find relevant articles, then use pixelrag_tile to view specific tiles.",
    {
      query: z.string().describe("Natural language search query"),
      n_results: z.number().int().min(1).max(20).optional().describe("Number of results (default 5)"),
    },
    async (args) => {
      onEvent("searching", { query: args.query })
      const resp = await fetch(`${SEARCH_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: [{ text: args.query }], n_docs: args.n_results ?? 5 }),
      })
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Search API error: ${resp.status}` }] }
      }
      const data = await resp.json()
      const hits = data.results?.[0]?.hits ?? []
      const results = hits.map((h) => {
        const slug = h.url.includes("/wiki/") ? h.url.split("/wiki/").pop() : h.url
        return {
          title: decodeURIComponent(slug || "").replace(/_/g, " "),
          url: h.url.startsWith("http") ? h.url : `https://en.wikipedia.org/wiki/${slug}`,
          score: Math.round(h.score * 1000) / 1000,
          article_id: h.article_id,
          tile_index: h.tile_index,
          chunk_index: h.chunk_index,
        }
      })
      onEvent("search_results", { query: args.query, hits })
      return {
        content: [{ type: "text", text: JSON.stringify({ query: args.query, results, count: results.length }, null, 2) }],
      }
    }
  )

  const tileTool = tool(
    "pixelrag_tile",
    "View a Wikipedia screenshot tile by its coordinates. Returns the tile as an image so you can read the visual content. Use after pixelrag_search to read the actual article content.",
    {
      article_id: z.number().int().describe("Article ID from search results"),
      tile_index: z.number().int().describe("Tile index from search results"),
      chunk_index: z.number().int().describe("Chunk index from search results"),
    },
    async (args) => {
      const tileUrl = `${SEARCH_URL}/tile/${args.article_id}/${args.tile_index}/${args.chunk_index}`
      onEvent("viewing_tile", { article_id: args.article_id, tile_index: args.tile_index, chunk_index: args.chunk_index })
      try {
        const resp = await fetch(tileUrl)
        if (!resp.ok) return { content: [{ type: "text", text: `Tile not found: ${resp.status}` }] }
        const buffer = await resp.arrayBuffer()
        const base64 = Buffer.from(buffer).toString("base64")
        const mimeType = resp.headers.get("content-type") || "image/png"
        return { content: [{ type: "image", data: base64, mimeType }] }
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to fetch tile: ${err}` }] }
      }
    }
  )

  return [searchTool, tileTool]
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok" }))
    return
  }

  if (req.method !== "POST" || !req.url.startsWith("/chat")) {
    res.writeHead(404); res.end("Not found"); return
  }

  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", async () => {
    let clientMessages
    try {
      clientMessages = JSON.parse(body).messages
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "invalid json" }))
      return
    }
    if (!Array.isArray(clientMessages) || clientMessages.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "messages required" }))
      return
    }

    // Rate limit (trust X-Forwarded-For from the Vercel proxy)
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown").trim()
    const gate = rateLimit(ip, Date.now())
    if (!gate.ok) {
      log(`rate-limited ${ip}: ${gate.reason}`)
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.write(sse("error", { message: gate.reason }))
      res.write(sse("done", {}))
      res.end()
      return
    }

    const history = clientMessages.filter((m) => m.content).map((m) => `${m.role}: ${m.content}`).join("\n\n")
    const prompt = clientMessages.length === 1
      ? clientMessages[0].content
      : `Previous conversation:\n${history}\n\nRespond to the last user message.`

    const t0 = Date.now()
    log(`chat: ${clientMessages.length} msgs, last="${clientMessages[clientMessages.length - 1]?.content?.slice(0, 60)}"`)

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    const send = (event, data) => res.write(sse(event, data))
    const tools = createTools(send)
    const mcpServer = createSdkMcpServer({ name: "pixelrag", version: "1.0.0", tools })

    inFlight++
    try {
      let sentText = false
      for await (const message of query({
        prompt,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { pixelrag: mcpServer },
          allowedTools: ["mcp__pixelrag__pixelrag_search", "mcp__pixelrag__pixelrag_tile"],
          maxTurns: 12,
          maxBudgetUsd: MAX_BUDGET,
          maxThinkingTokens: THINKING_TOKENS,
          includePartialMessages: true,
          model: "sonnet",
        },
      })) {
        // Stream extended-thinking deltas (Claude Code-style reasoning trace)
        if (message.type === "stream_event") {
          const ev = message.event
          if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
            send("thinking", { text: ev.delta.thinking })
          }
          continue
        }
        if (message.type === "assistant" && message.message) {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text) { send("text", { text: block.text }); sentText = true }
          }
        }
        if (message.type === "result" && message.subtype === "success" && !sentText) {
          send("text", { text: message.result })
        }
      }
      send("done", {})
      log(`chat done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (err) {
      log("chat error:", String(err))
      send("error", { message: String(err) })
    } finally {
      inFlight--
      res.end()
    }
  })
})

server.listen(PORT, () => {
  log(`PixelRAG agent server on :${PORT} → search ${SEARCH_URL}, budget $${MAX_BUDGET}/conv`)
})
