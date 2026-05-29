# PixelRAG

Visual Retrieval-Augmented Generation — a framework for building visual search systems from any document type.

PixelRAG renders documents (web pages, PDFs, images) as screenshots, embeds them with a vision-language model, builds FAISS indexes, and serves a search API. Wikipedia's 8.28M articles are the primary benchmark, but the system is general-purpose.

## Architecture

Five packages, each independently installable:

| Package             | What it does                                                    | Install                             |
| ------------------- | --------------------------------------------------------------- | ----------------------------------- |
| **pixelrag-render** | Document → image tiles (Playwright CDP, PDF)                    | `uv sync --package pixelrag-render` |
| **pixelrag-embed**  | Tiles → vectors → FAISS index (three independent tools)         | `uv sync --package pixelrag-embed`  |
| **pixelrag-index**  | Orchestrates the full pipeline: source → ingest → embed → index | `uv sync --package pixelrag-index`  |
| **pixelrag-serve**  | FAISS search API (FastAPI, CPU or GPU)                          | `uv sync --package pixelrag-serve`  |
| **pixelrag-train**  | LoRA fine-tuning for Qwen3-VL-Embedding                    | `cd train && uv sync`               |

```
render ←── index ──→ embed       serve (independent)       train → serve (HTTP)
```

`render`/`embed`/`index`/`serve` share the root workspace. **`train` is a separate
uv project** with its own pinned env (`torch==2.9.1+cu129`, `transformers==4.57.1`,
cuDNN 9.20) — install it from inside `train/`, not from the root.

## Quick Start

### Search pre-built Wikipedia index

```bash
uv sync --package pixelrag-serve

# Download a pre-built index
aws s3 sync s3://wiki-screenshot-tiles-backup/kiwix_tiles/text_search_index_1024/ ./index/

# Start the API
pixelrag-serve --index-dir ./index --port 30001

# Query
curl -X POST http://localhost:30001/search \
  -H "Content-Type: application/json" \
  -d '{"queries": [{"text": "What is the capital of France?"}], "n_docs": 5}'
```

### Build an index from local documents

```bash
uv sync --package pixelrag-index

# Create pixelrag.yaml
cat > pixelrag.yaml << 'EOF'
source:
  type: local
  path: ./my_docs

embed:
  model: Qwen/Qwen3-VL-Embedding-2B
  device: cuda
  gpu_ids: [0]

output: ./my_index
EOF

# Build
pixelrag-index build

# Serve
pixelrag-serve --index-dir ./my_index --port 30001
```

### Render a single URL (agent use)

```python
from pixelrag_render import render_url

tiles = render_url("https://en.wikipedia.org/wiki/Python", "./tiles")
```

### Claude Code plugin — give Claude eyes

Setup (one-time):

```bash
./plugin/setup.sh
```

Then copy-paste any of these:

```bash
# "What does Hacker News look like right now?"
claude --plugin-dir ./plugin -p "screenshot https://news.ycombinator.com and summarize the top stories"

# "Read a research paper visually"
claude --plugin-dir ./plugin -p "screenshot https://arxiv.org/abs/2404.12387 and explain the key findings"

# "Check if my site looks right"
claude --plugin-dir ./plugin -p "screenshot http://localhost:3000 and tell me if anything looks broken"
```

Or start an interactive session and use the slash command:

```bash
claude --plugin-dir ./plugin
# then type: /screenshot https://example.com
```

No MCP server, no backend required — the plugin teaches Claude to call `pixelrag-render` directly via Bash and read the resulting tile images.

## Embed tools (standalone)

Each tool works independently without the orchestrator:

```bash
pixelrag-chunk --tiles-dir ./tiles
pixelrag-embed --shard-dir ./tiles --output-dir ./embeddings --gpu-ids 0,1
pixelrag-build-index --embeddings-dir ./embeddings --output-dir ./index
```

## Training

`pixelrag-train` LoRA fine-tunes `Qwen/Qwen3-VL-Embedding-2B` for webpage
retrieval. See [`train/README.md`](train/README.md) for the full recipe.

The trained adapters are published at
[`Chrisyichuan/wiki-screenshot-embedding-lora`](https://huggingface.co/Chrisyichuan/wiki-screenshot-embedding-lora/tree/main/lora_vit/ckpt200)
— you don't need to retrain to use the model.

We also release all the training data
([`Chrisyichuan/screenshot-training-natural-filtered-v2`](https://huggingface.co/datasets/Chrisyichuan/screenshot-training-natural-filtered-v2)),
so you can adapt other models yourself — e.g. a larger Qwen or any other
embedding backbone.

## License

Apache-2.0
