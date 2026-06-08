# Synthetic Data Generation Pipeline

End-to-end pipeline for generating the `screenshot-training-natural-filtered-v2`
training dataset used to fine-tune `Qwen3-VL-Embedding-2B` for visual document
retrieval.

The pipeline produces ~115K high-quality query→screenshot-chunk pairs with hard
negatives, starting from raw Wikipedia screenshot tiles.

---

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    VISUAL QUERY PIPELINE                            │
│                                                                     │
│  Wikipedia pages (kiwix_tiles/)                                     │
│       │                                                             │
│       ▼                                                             │
│  ① generate_query_pairs.py          Gemini reads screenshot chunks, │
│       │                              generates Q/A pairs            │
│       ▼                                                             │
│  ② filter_self_contained.py         GPT-4o removes non-self-        │
│       │                              contained queries              │
│       ▼                                                             │
│  ③ mine_hard_negatives.py           Search API retrieves confusable │
│       │                              chunks as hard negatives       │
│       ▼                                                             │
│  ④ filter_hard_negatives_vqa.py     VLM removes false negatives    │
│       │                              (chunks that actually answer   │
│       │                               the query)                    │
│       ▼                                                             │
│  ⑤ clean_queries_simpleqa_style.py  Score naturalness + factoid     │
│       │                              style fit via Gemini           │
│       ▼                                                             │
│  ⑥ export_natural_filtered_v2.py    Keep only naturalness≥4 &      │
│       │                              style_fit≥4                    │
│       ▼                                                             │
│  ⑦ split_first5_chunks.py          90/5/5 train/eval/test split    │
│       │                                                             │
│       ▼                                                             │
│  ⑧ prepare_hf_dataset.py           Package for Hugging Face        │
│     package_hf_image_shards.py                                      │
│     upload_hf_dataset.py                                            │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    TEXT WARMUP PIPELINE                              │
│                                                                     │
│  Text passage DB (text_baseline.db)                                 │
│       │                                                             │
│       ▼                                                             │
│  ① generate_text_query_pairs.py     Gemini reads text passages,    │
│       │                              generates Q/A pairs            │
│       ▼                                                             │
│  ② filter_self_contained.py         Same filter as visual pipeline  │
│       │                                                             │
│       ▼                                                             │
│  ③ mine_text_hard_negatives.py      Text search API retrieves      │
│       │                              confusable passages            │
│       ▼                                                             │
│  ④ filter_text_hard_negatives_llm.py  LLM removes false negatives  │
│                                                                     │
│  Output: text-qa-pair dataset (used for --text-warmup-steps)        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### Data sources

| Resource | Purpose | Approx. size |
|----------|---------|-------------|
| `kiwix_tiles/` directory | Wikipedia screenshot tiles with `index.jsonl` | ~500 GB |
| `text_baseline.db` (SQLite) | Wikipedia text passages for text warmup | ~20 GB |
| Search API (`:30888`) | Hard negative mining (retrieval over the tile index) | running service |

### API keys

| Key | Used by | Purpose |
|-----|---------|---------|
| Google Cloud ADC | `generate_query_pairs.py`, `generate_text_query_pairs.py`, `clean_queries_simpleqa_style.py` | Gemini models via Vertex AI |
| `OPENAI_API_KEY` | `filter_self_contained.py`, `filter_hard_negatives_vqa.py` | GPT-4o for query filtering and VQA false-negative removal |

```bash
# Google Cloud (one-time setup)
gcloud auth application-default login

# OpenAI
export OPENAI_API_KEY="sk-proj-..."
export OPENAI_BASE_URL="https://us.api.openai.com/v1"  # if your key requires this
```

---

## Step-by-Step Reproduction

### Step 1: Generate Visual Query Pairs

Send screenshot chunks to Gemini, which generates factual Q/A pairs.

**Script:** `generate_query_pairs.py`

**What it does:**
1. Loads `index.jsonl` from the kiwix_tiles directory
2. Filters out infrastructure pages (disambiguation, elections, lists, etc.)
3. For each eligible page, picks a random chunk from the first 70% of chunks
4. Sends the chunk image to Gemini with a detailed prompt
5. Gemini generates a Q/A pair with source_type and subject labels
6. Post-generation filters reject layout-bound or unnatural questions

**Single batch:**
```bash
uv run python generate_query_pairs.py \
    --tiles-dir /opt/dlami/nvme/kiwix_tiles \
    --num-pages 2000 \
    --model gemini-3.1-flash-lite-preview \
    --output batches/batch_000.jsonl \
    --seed 0
```

**Full-scale generation (120 non-overlapping batches):**
```bash
bash run_generate_batches.sh /opt/dlami/nvme/kiwix_tiles 0 119 gemini-3.1-flash-lite-preview
```

This produces ~195K raw pairs across 120 batch files.

**Output format:**
```json
{
  "query": "In what year did Henryk Skarżyński perform the first cochlear implantation in Poland?",
  "answer": "1992",
  "source_sentence": "He performed the first operation of cochlear implantation in Poland...",
  "source_type": "prose",
  "subject": "medicine",
  "chunk_path": "shard_400/shard_00010/3316848.png.tiles/chunk_0000_00.png",
  "url": "https://en.wikipedia.org/wiki/Henryk_Skarżyński",
  "title": "Henryk Skarżyński",
  "chunk_index": 0,
  "tiles_dir": "shard_400/shard_00010/3316848.png.tiles"
}
```

**Cost estimate:** ~$100–200 for 195K pairs with Flash Lite, ~$2000 with Pro.

**Merge all batches:**
```bash
cat batches/batch_*.jsonl > raw_query_pairs.jsonl
wc -l raw_query_pairs.jsonl  # expect ~195K
```

### Step 2: Filter Self-Contained Queries

Remove queries that reference the page layout ("in the table") or use vague
references ("the team", "the film") without naming the entity.

**Script:** `filter_self_contained.py`

```bash
OPENAI_API_KEY=sk-... uv run python filter_self_contained.py \
    --input raw_query_pairs.jsonl \
    --output filtered_query_pairs.jsonl \
    --model gpt-4o
```

**Expected results:**
- Drop rate: ~15% (29K dropped from 195K)
- Cost: ~$23 with GPT-4o
- Runtime: ~8 minutes

**Test run first:**
```bash
OPENAI_API_KEY=sk-... uv run python filter_self_contained.py \
    --input raw_query_pairs.jsonl \
    --output /dev/null \
    --model gpt-4o \
    --test-first 100
```

### Step 3: Mine Hard Negatives

For each (query, positive_chunk) pair, retrieve top-K candidates from the search
API. Non-positive results become hard negatives.

**Script:** `mine_hard_negatives.py` (already in this repo)

**Prerequisite:** Search API running at `localhost:30888` (see `serve/` and `deploy/`).

```bash
uv run python mine_hard_negatives.py \
    --input filtered_query_pairs.jsonl \
    --output filtered_query_pairs_hn.jsonl \
    --num-negatives 7 \
    --n-docs 50 \
    --filter-mode margin \
    --margin 0.95
```

**Output adds:**
```json
{
  "query": "...",
  "chunk_path": "...",
  "neg_chunk_paths": ["/path/to/neg1.png", "/path/to/neg2.png", "..."],
  "retrieve_top20": [{"rank": 1, "path": "...", "score": 0.61}, "..."],
  "positive_score": 0.65,
  "positive_rank": 1
}
```

### Step 4: Filter Hard Negatives (VQA-based)

Remove false negatives — mined "negatives" that actually do answer the query.
A VLM answers the query from each candidate image; if it gets the answer right,
that candidate is NOT a true hard negative and is removed.

**Script:** `filter_hard_negatives_vqa.py` / `run_filter_hard_negatives_chunks.py`

For large files, use the chunked runner for resumability:
```bash
uv run python run_filter_hard_negatives_chunks.py \
    --input-jsonl filtered_query_pairs_hn.jsonl \
    --output-dir training/data/filtered_hn_chunks \
    --chunk-size 10000 \
    --skip-existing
```

Each chunk produces:
- `filtered_hn.jsonl` — the cleaned hard negatives
- `candidate_reviews.jsonl` — per-candidate VLM judgments
- `summary.json` — statistics

### Step 5: Clean Queries (Naturalness Scoring)

Score each query on naturalness (1–5) and factoid style fit (1–5) using Gemini.
This step does NOT look at images — only the query text is judged.

**Script:** `clean_queries_simpleqa_style.py`

```bash
uv run python clean_queries_simpleqa_style.py \
    --model gemini-2.0-flash-001 \
    --target-count 50000 \
    --batch-size 20 \
    --concurrency 8 \
    --dedupe-query \
    --output training/data/cleaned/simpleqa_style_cleaned.jsonl \
    --reviews-output training/data/cleaned/simpleqa_style_cleaned.reviews.jsonl \
    --summary-output training/data/cleaned/simpleqa_style_cleaned.summary.json
```

### Step 6: Export Strict Retained Rows

Keep only rows with `naturalness >= 4` and `simpleqa_style_fit >= 4`.

**Script:** `export_natural_filtered_v2.py`

```bash
uv run python export_natural_filtered_v2.py \
    --reviews training/data/cleaned/simpleqa_style_cleaned.reviews.jsonl \
    --output-dir training/data/natural_filtered_v2 \
    --output-name filtered_hn.jsonl \
    --min-naturalness 4 \
    --min-style-fit 4
```

**Expected:** ~77% keep rate → ~115K rows from 150K input.

### Step 7: Split into Train/Eval/Test

**Script:** `split_first5_chunks.py`

```bash
uv run python split_first5_chunks.py \
    --inputs training/data/natural_filtered_v2/filtered_hn.jsonl \
    --output-dir training/data/natural_filtered_v2/split \
    --seed 42 \
    --train-ratio 0.9 \
    --eval-ratio 0.05 \
    --test-ratio 0.05
```

Output:
- `split/train_hn.jsonl` (~104K)
- `split/eval_hn.jsonl` (~5.8K)
- `split/test_hn.jsonl` (~5.8K)

### Step 8: Package and Upload to Hugging Face

```bash
# Materialize images (hardlinks from kiwix_tiles)
uv run python prepare_hf_dataset.py \
    --split-dir training/data/natural_filtered_v2/split \
    --image-root /opt/dlami/nvme/kiwix_tiles \
    --output-dir /opt/dlami/nvme/hf_export/screenshot-training-natural-filtered-v2 \
    --repo-id Chrisyichuan/screenshot-training-natural-filtered-v2

# Create tar shards (1000 shards, ~93.5 GB total)
uv run python package_hf_image_shards.py \
    --source-dir /opt/dlami/nvme/hf_export/screenshot-training-natural-filtered-v2 \
    --output-dir /opt/dlami/nvme/hf_export_sharded/screenshot-training-natural-filtered-v2 \
    --overwrite

# Upload
uv run python upload_hf_dataset.py \
    --repo-id Chrisyichuan/screenshot-training-natural-filtered-v2 \
    --local-dir /opt/dlami/nvme/hf_export_sharded/screenshot-training-natural-filtered-v2 \
    --repo-type dataset \
    --skip-create
```

---

## Text Warmup Data Pipeline

The text warmup pipeline generates `text-qa-pair` data used for the
`--text-warmup-steps` phase of training. It follows a parallel track.

### Generate Text Query Pairs

**Script:** `generate_text_query_pairs.py`

```bash
uv run python generate_text_query_pairs.py \
    --db-path /opt/dlami/nvme/text_embeddings_1024/text_baseline.db \
    --num-articles 52000 \
    --model gemini-3.1-flash-lite-preview \
    --output text_query_pairs.jsonl \
    --min-article-chunks 6 \
    --min-paragraph-words 60
```

The script:
1. Queries the SQLite DB for articles with ≥6 chunks
2. For each article, selects a chunk with a long natural prose paragraph
3. Sends the passage to Gemini with 5-shot examples
4. Filters for natural, self-contained prose questions
5. Verifies the supporting span exists verbatim in the passage

**Expected yield:** ~40% (21K pairs from 52K articles).  
**Cost:** ~$110 with Flash Lite.

### Filter + Mine + Package

```bash
# Filter self-contained (same script as visual pipeline)
OPENAI_API_KEY=sk-... uv run python filter_self_contained.py \
    --input text_query_pairs.jsonl \
    --output text_query_pairs_filtered.jsonl \
    --model gpt-4o

# Mine text hard negatives (requires text search API on :30889)
uv run python mine_text_hard_negatives.py \
    --input text_query_pairs_filtered.jsonl \
    --output text_query_pairs_hn.jsonl

# Filter text hard negatives
uv run python run_filter_text_hard_negatives_chunks.py \
    --input-jsonl text_query_pairs_hn.jsonl \
    --output-dir training/data/text_filtered_hn_chunks
```

---

## Script Inventory

### Query Generation (Steps 1–2)

| Script | Input | Output | API |
|--------|-------|--------|-----|
| `generate_query_pairs.py` | kiwix_tiles/ + index.jsonl | raw visual Q/A pairs (JSONL) | Gemini (Vertex AI) |
| `generate_text_query_pairs.py` | text_baseline.db (SQLite) | raw text Q/A pairs (JSONL) | Gemini + OpenAI fallback |
| `filter_self_contained.py` | any Q/A JSONL | filtered JSONL (non-self-contained removed) | OpenAI (GPT-4o) |
| `run_generate_batches.sh` | kiwix_tiles/ | batched generation wrapper | — |

### Hard Negative Mining (Step 3)

| Script | Input | Output | API |
|--------|-------|--------|-----|
| `mine_hard_negatives.py` | filtered Q/A JSONL | JSONL with `neg_chunk_paths` | Search API (:30888) |
| `mine_text_hard_negatives.py` | filtered text Q/A JSONL | JSONL with `neg_passages` | Text search API (:30889) |

### Hard Negative Filtering (Step 4)

| Script | Input | Output | API |
|--------|-------|--------|-----|
| `filter_hard_negatives_vqa.py` | HN JSONL | cleaned HN JSONL | OpenAI/Gemini (VLM) |
| `run_filter_hard_negatives_chunks.py` | large HN JSONL | chunked output dir | — |
| `filter_text_hard_negatives_llm.py` | text HN JSONL | cleaned text HN JSONL | OpenAI/Gemini (LLM) |
| `run_filter_text_hard_negatives_chunks.py` | large text HN JSONL | chunked output dir | — |

### Query Cleaning & Export (Steps 5–7)

| Script | Input | Output | API |
|--------|-------|--------|-----|
| `clean_queries_simpleqa_style.py` | filtered HN JSONL | reviews JSONL with scores | Gemini |
| `export_natural_filtered_v2.py` | reviews JSONL | strict-filtered JSONL | — |
| `split_first5_chunks.py` | filtered JSONL | train/eval/test split | — |

### Dataset Packaging (Step 8)

| Script | Input | Output | API |
|--------|-------|--------|-----|
| `prepare_hf_dataset.py` | split dir + image root | HF dataset folder | — |
| `package_hf_image_shards.py` | HF dataset folder | tar-sharded images | — |
| `upload_hf_dataset.py` | sharded dataset | HF Hub upload | HF API |
| `extract_hf_image_shards.py` | downloaded shards | extracted images/ | — |

---

## Cost Estimates (Full Pipeline)

| Step | Model | Volume | Est. Cost |
|------|-------|--------|-----------|
| Generate visual queries | gemini-3.1-flash-lite | 195K pairs | ~$150 |
| Filter self-contained | gpt-4o | 195K queries | ~$23 |
| Generate text queries | gemini-3.1-flash-lite + gpt-4o-mini fallback | 52K articles | ~$110 |
| Filter text self-contained | gpt-4o | 21K queries | ~$3 |
| Filter HN (VQA) | gpt-4o / gemini | 150K × 7 candidates | ~$200 |
| Clean queries (naturalness) | gemini-2.0-flash | 150K queries | ~$15 |
| **Total** | | | **~$500** |

---

## Data Formats

### Raw Q/A pair (after Step 1)
```json
{
  "query": "What is the population of Tokyo?",
  "answer": "13.96 million",
  "source_sentence": "Tokyo has a population of 13.96 million...",
  "source_type": "prose",
  "subject": "geography",
  "chunk_path": "shard_400/shard_00010/350170.png.tiles/chunk_0000_00.png",
  "url": "https://en.wikipedia.org/wiki/Tokyo",
  "title": "Tokyo",
  "chunk_index": 0,
  "tiles_dir": "shard_400/shard_00010/350170.png.tiles"
}
```

### With hard negatives (after Step 3)
```json
{
  "query": "...",
  "chunk_path": "...",
  "neg_chunk_paths": ["/path/to/neg1.png", "/path/to/neg2.png"],
  "retrieve_top20": [{"rank": 1, "path": "...", "score": 0.61}],
  "positive_score": 0.65,
  "positive_rank": 1
}
```

### Published HF format (after Step 8)
```json
{
  "query": "...",
  "chunk_path": "images/shard_000/...",
  "neg_chunk_paths": ["images/shard_001/...", "images/shard_002/..."],
  "source_positive_rank": 1,
  "source_positive_score": 0.63
}
```

---

## Quality Control

### Page-level filtering (Step 1)
- Skip infrastructure pages (disambiguation, category, template, portal)
- Skip low-quality content (elections, census, track listings, episode lists)
- Require page_height ≥ 3000px, ≥1 tile, complete capture

### Query-level filtering

| Filter | What it catches | Drop rate |
|--------|----------------|-----------|
| `is_natural_question()` (Step 1) | Layout references, dangling entities, truncated answers | ~30% of raw Gemini output |
| `filter_self_contained.py` (Step 2) | Unnamed subjects, document-structure references | ~15% |
| `clean_queries_simpleqa_style.py` (Step 5) | Templatic phrasing, poor naturalness | ~23% |

### Hard negative quality (Step 4)
The VQA filter ensures hard negatives are truly *confusable but wrong*:
1. VLM tries to answer the query from the candidate image
2. A judge grades the answer as CORRECT / WRONG / CANNOT_ANSWER
3. Only WRONG or CANNOT_ANSWER candidates are kept as hard negatives
4. If the positive image itself fails the VQA check, the entire row is skipped

---

## Differences from Published Dataset

The published `screenshot-training-natural-filtered-v2` was generated with:
- **Visual queries:** `gemini-3.1-flash-lite-preview` (120 batches, 195K raw → 165K filtered)
- **Self-contained filter:** `gpt-4o` (15% drop rate, zero false keeps)
- **Naturalness cleaning:** `gemini-2.0-flash-001`
- **Naturalness thresholds:** `naturalness ≥ 4`, `simpleqa_style_fit ≥ 4`
- **Final size:** 115,593 rows → 104K train / 5.8K eval / 5.8K test
