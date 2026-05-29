import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

const SEARCH_URL =
  process.env.PIXELRAG_SEARCH_URL || "http://localhost:30001"

interface SearchHit {
  score: number
  article_id: number
  tile_index: number
  chunk_index: number
  url: string
  tile_height: number
}

const SYSTEM_PROMPT = `You are a research assistant with access to a visual Wikipedia search engine (PixelRAG).

Workflow:
1. Use pixelrag_search to find relevant Wikipedia articles by query
2. Use pixelrag_tile to VIEW the actual screenshot tiles from top results — this is how you read the content
3. Synthesize an answer based on what you see in the tiles

Always view at least 2-3 tiles before answering. The tiles contain the actual Wikipedia content as rendered screenshots — read them carefully. Cite your sources with Wikipedia URLs.

If search results are insufficient, say so honestly rather than guessing.`

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function createTools(onEvent: (event: string, data: unknown) => void) {
  const searchTool = tool(
    "pixelrag_search",
    "Search the visual Wikipedia index. Returns ranked results with article URLs and tile positions. Use this first to find relevant articles, then use pixelrag_tile to view specific tiles.",
    {
      query: z.string().describe("Natural language search query"),
      n_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of results (default 5)"),
    },
    async (args) => {
      onEvent("searching", { query: args.query })

      const resp = await fetch(`${SEARCH_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: [{ text: args.query }],
          n_docs: args.n_results ?? 5,
        }),
      })
      if (!resp.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search API error: ${resp.status}`,
            },
          ],
        }
      }
      const data = await resp.json()
      const hits: SearchHit[] = data.results?.[0]?.hits ?? []
      const results = hits.map((h: SearchHit) => {
        const slug = h.url.includes("/wiki/")
          ? h.url.split("/wiki/").pop()
          : h.url
        return {
          title: decodeURIComponent(slug || "").replace(/_/g, " "),
          url: h.url.startsWith("http")
            ? h.url
            : `https://en.wikipedia.org/wiki/${slug}`,
          score: Math.round(h.score * 1000) / 1000,
          article_id: h.article_id,
          tile_index: h.tile_index,
          chunk_index: h.chunk_index,
        }
      })

      onEvent("search_results", { query: args.query, hits })

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { query: args.query, results, count: results.length },
              null,
              2
            ),
          },
        ],
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

      onEvent("viewing_tile", {
        article_id: args.article_id,
        tile_index: args.tile_index,
        chunk_index: args.chunk_index,
      })

      try {
        const resp = await fetch(tileUrl)
        if (!resp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Tile not found: ${resp.status}`,
              },
            ],
          }
        }
        const buffer = await resp.arrayBuffer()
        const base64 = Buffer.from(buffer).toString("base64")
        const contentType =
          resp.headers.get("content-type") || "image/png"

        return {
          content: [
            {
              type: "image" as const,
              data: base64,
              mimeType: contentType,
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch tile: ${err}`,
            },
          ],
        }
      }
    }
  )

  return [searchTool, tileTool]
}

export async function POST(req: Request) {
  const { messages: clientMessages } = await req.json()
  if (!Array.isArray(clientMessages) || clientMessages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const conversationHistory = clientMessages
    .filter((m: { content: string }) => m.content)
    .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
    .join("\n\n")

  const prompt =
    clientMessages.length === 1
      ? clientMessages[0].content
      : `Previous conversation:\n${conversationHistory}\n\nRespond to the last user message.`

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(sseEvent(event, data)))
      }

      const tools = createTools(send)
      const mcpServer = createSdkMcpServer({
        name: "pixelrag",
        version: "1.0.0",
        tools,
      })

      try {
        let sentText = false
        for await (const message of query({
          prompt,
          options: {
            systemPrompt: SYSTEM_PROMPT,
            mcpServers: { pixelrag: mcpServer },
            allowedTools: [
              "mcp__pixelrag__pixelrag_search",
              "mcp__pixelrag__pixelrag_tile",
            ],
            maxTurns: 15,
            maxBudgetUsd: parseFloat(
              process.env.CHAT_MAX_BUDGET_USD || "0.50"
            ),
            model: "sonnet",
          },
        })) {
          if (
            message.type === "assistant" &&
            "message" in message &&
            message.message
          ) {
            const msg = message.message as {
              content: Array<{
                type: string
                text?: string
              }>
            }
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                send("text", { text: block.text })
                sentText = true
              }
            }
          }

          if (
            message.type === "result" &&
            message.subtype === "success" &&
            !sentText
          ) {
            send("text", { text: message.result })
          }
        }

        send("done", {})
      } catch (err) {
        send("error", { message: String(err) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
