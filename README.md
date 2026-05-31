<p align="center">
  <img src="docs/assets/banner.png" alt="PixelRAG — Visual Retrieval-Augmented Generation" width="100%">
</p>
<p align="center">Search any document by how it <em>looks</em>, not just the text it contains.</p>

<p align="center">
  <a href="https://github.com/StarTrail-org/PixelRAG/actions/workflows/ci.yml"><img src="https://github.com/StarTrail-org/PixelRAG/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://pixelrag.ai"><img src="https://img.shields.io/badge/demo-pixelrag.ai-7c3aed" alt="Live demo"></a>
  <a href="https://status.pixelrag.ai"><img src="https://img.shields.io/badge/status-live-22c55e" alt="Status"></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License">
</p>

<p align="center">
  <a href="#what-it-is">What it is</a> &middot;
  <a href="#give-claude-eyes">Give Claude eyes</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#pipelines">Pipelines</a>
</p>

---

```bash
pip install pixelrag  # TODO: not on PyPI yet — publish, then this is the one-line install
```

The two core operations — **render** a page to screenshots, **search** a visual index:

```bash
# Render any page or document to screenshot tiles
pixelshot https://en.wikipedia.org/wiki/Python --output ./tiles

# Search a hosted index of 8.28M Wikipedia pages — no setup, runs against the live API
curl -X POST http://api.pixelrag.ai:30001/search \
  -H "Content-Type: application/json" \
  -d '{"queries": [{"text": "What is the capital of France?"}], "n_docs": 5}'
```

Or try it in the browser at **[pixelrag.ai](https://pixelrag.ai)**.

## What it is

PixelRAG renders documents — web pages, PDFs, images — as screenshots and retrieves over the
images directly. Visual structure that HTML parsing throws away — tables, charts, layout,
infographics — stays intact, so the reader model can actually answer questions about it.
Wikipedia's 8.28M articles ship as a pre-built index; the pipeline itself is general-purpose.

## Give Claude eyes

The renderer also ships as a Claude Code plugin — the **pixelbrowse** skill. Instead of fetching
raw HTML, Claude screenshots a page with `pixelshot` and *reads the image*, so it sees
charts, diagrams, tables, and layout the way a person does.

```bash
# One-time setup
./plugin/setup.sh

# Then run it in one shot — claude -p with the plugin:
claude --plugin-dir ./plugin -p "screenshot https://news.ycombinator.com and summarize the top stories"
claude --plugin-dir ./plugin -p "screenshot https://arxiv.org/abs/2404.12387 and explain the key findings"
claude --plugin-dir ./plugin -p "screenshot http://localhost:3000 and tell me if anything looks broken"
```

Or interactively — `claude --plugin-dir ./plugin`, then `/screenshot https://example.com`.
No MCP server, no backend: the skill just calls `pixelshot` (Playwright/CDP) on your machine.

## How it works

<p align="center">
  <img src="docs/assets/pipeline.png" alt="Text-based RAG parses to text and loses the table; PixelRAG renders to screenshot tiles and keeps it" width="100%">
</p>

Text-based RAG parses the page to text chunks and **loses the table** — the reader can't find the
answer. PixelRAG renders the page to **screenshot tiles**, retrieves the right tile, and the reader
reads the number straight off the image.

Two pieces make this work: (1) rendering documents to images instead of parsing them to text, and
(2) a `Qwen3-VL-Embedding` model, LoRA-fine-tuned on screenshot data, that embeds page images into
a space where visual content is retrievable.

## Pipelines

Five packages, each independently installable:

| Package             | What it does                                                    | Install                             |
| ------------------- | --------------------------------------------------------------- | ----------------------------------- |
| **pixelrag-render** | Document → image tiles — the `pixelshot` CLI (Playwright CDP, PDF) | `uv sync --package pixelrag-render` |
| **pixelrag-embed**  | Tiles → vectors → FAISS index (three independent tools)         | `uv sync --package pixelrag-embed`  |
| **pixelrag-index**  | Orchestrates the full pipeline: source → ingest → embed → index | `uv sync --package pixelrag-index`  |
| **pixelrag-serve**  | FAISS search API (FastAPI, CPU or GPU)                          | `uv sync --package pixelrag-serve`  |
| **pixelrag-train**  | LoRA fine-tuning for Qwen3-VL-Embedding                         | `cd train && uv sync`               |

```
render ←── index ──→ embed       serve (independent)       train → serve (HTTP)
```

`render`/`embed`/`index`/`serve` share the root workspace. **`train` is a separate uv project**
with its own pinned env (`torch==2.9.1+cu129`, `transformers==4.57.1`, cuDNN 9.20) — install it
from inside `train/`, not from the root.

### Search a pre-built index

```bash
uv sync --package pixelrag-serve

# Download the pre-built Wikipedia index (8.28M pages) from Hugging Face
# TODO: publish the index to Hugging Face, then replace <HF_REPO> below
huggingface-cli download <HF_REPO> --repo-type dataset --local-dir ./index

# Serve, then query
pixelrag-serve --index-dir ./index --port 30001

curl -X POST http://localhost:30001/search \
  -H "Content-Type: application/json" \
  -d '{"queries": [{"text": "What is the capital of France?"}], "n_docs": 5}'
```

### Build an index from your own documents

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

# Build, then serve
pixelrag-index build
pixelrag-serve --index-dir ./my_index --port 30001
```

### Render a page programmatically

```python
from pixelrag_render import render_url

# render a single page to tiles — e.g. for an agent to read
tiles = render_url("https://en.wikipedia.org/wiki/Python", "./tiles")
```

### Embed tools (standalone)

Each tool runs independently, without the orchestrator:

```bash
pixelrag-chunk --tiles-dir ./tiles
pixelrag-embed --shard-dir ./tiles --output-dir ./embeddings --gpu-ids 0,1
pixelrag-build-index --embeddings-dir ./embeddings --output-dir ./index
```

### Training

`pixelrag-train` LoRA fine-tunes `Qwen/Qwen3-VL-Embedding-2B` for webpage retrieval.
See [`train/README.md`](train/README.md) for the full recipe.

You don't need to retrain to use the model — the trained adapters are published at
[`Chrisyichuan/wiki-screenshot-embedding-lora`](https://huggingface.co/Chrisyichuan/wiki-screenshot-embedding-lora/tree/main/lora_vit/ckpt200).

We also release the full training set
([`Chrisyichuan/screenshot-training-natural-filtered-v2`](https://huggingface.co/datasets/Chrisyichuan/screenshot-training-natural-filtered-v2)),
so you can adapt other backbones yourself — a larger Qwen, or any other embedding model.

## Acknowledgments

Thanks to [Rulin Shao](https://rulinshao.github.io/) for support.
Thanks also to [Claude Code](https://github.com/anthropics/claude-code) and
[OpenAI Codex](https://github.com/openai/codex) for supporting open-source contributors with credits and plans,
which we earned by working on [LEANN](https://github.com/StarTrail-org/LEANN).

## License

Apache-2.0
