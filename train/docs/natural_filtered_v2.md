## Natural Filtered V2

This document describes the dataset published at
`Chrisyichuan/screenshot-training-natural-filtered-v2`.

### What It Is

`screenshot-training-natural-filtered-v2` is a cleaned hard-negative training set
for screenshot retrieval.

It keeps the same core row structure as the existing HN training data:

```json
{
  "query": "...",
  "chunk_path": "...",
  "neg_chunk_paths": ["...", "..."],
  "source_positive_rank": 1,
  "source_positive_score": 0.63
}
```

The main difference is that the query text was filtered to be more natural and
closer to natural factoid-style questions.

### Why It Is Cleaner

The original synthetic queries were already useful, but many were still too
templatic. Common issues included:

- stiff openings like `In what year...` or `In which...`
- annotation-like phrasing rather than user-style questions
- weaker alignment with natural short factoid style

This version keeps only rows whose query passed both of these query-only filters:

- `naturalness >= 4`
- `simpleqa_style_fit >= 4`

These two scores were assigned by Gemini after comparing each query against
reference factoid questions. The model only judged the query text. It did not
look at the images or answers during this cleaning step.

### How It Was Built

The pipeline was:

1. Start from the full filtered hard-negative dataset in
   `training/data/lite-query-v2-full-filtered-hn-v2-chunks/chunk_*/filtered_hn.jsonl`.
2. Run `clean_queries_simpleqa_style.py` over all `149,991` rows.
3. Score each query against factoid-style references with:
   - `naturalness` on a 1-5 scale
   - `simpleqa_style_fit` on a 1-5 scale
4. Keep only rows with `naturalness >= 4` and `simpleqa_style_fit >= 4`.
5. Export the retained rows in original HN format to
   `training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn.jsonl`.
6. Split the cleaned data into train/eval/test.
7. Package the referenced images into tar shards and upload to Hugging Face.

Important: the intermediate command used `--target-count 50000`, but that only
controlled the auxiliary `simpleqa_style_cleaned_50k.jsonl` output. The
`simpleqa_style_cleaned_50k.reviews.jsonl` file still contains full-query
reviews for all `149,991` rows, and the final strict export was derived from
that full review file.

### Important Note On The Model

The original intent was to use Gemini 3.1 Flash for query cleaning.

In this environment, that model name was not available through the configured
Vertex project, so the actual cleaning run used `gemini-2.0-flash-001`.

That is the model used for the published `natural-filtered-v2` dataset.

### Dataset Sizes

Full reviewed pool:

- input rows: `149,991`

Strict retained subset:

- kept rows: `115,593`
- keep rate: `77.07%`

Split sizes:

- train: `104,033`
- eval: `5,779`
- test: `5,781`

An answer-enriched variant was also derived by joining
`training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn.jsonl` back to
`training/data/lite-query-v2-full-filtered.jsonl` via `(query, chunk_path)`.

- joined rows: `115,593 / 115,593`
- join success rate: `100.0%`

### Distribution Notes

Compared with the unfiltered synthetic HN data, this version is cleaner mainly
because the query distribution shifts toward more natural factoid prompts.

Examples of what improved:

- fewer templatic `In what...` openings
- more direct `What...` / `Who...` / `How many...` style questions
- better use of disambiguating context like years, titles, roles, and places
- closer stylistic match to natural factoid reference queries

The hard-negative structure itself was not re-mined here. We retained the
original positive image and hard negatives for each accepted row.

### Local Paths

Local cleaned dataset:

- `training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn.jsonl`

Local split files:

- `training/data/natrual_filtered_v2/split/train_hn.jsonl`
- `training/data/natrual_filtered_v2/split/eval_hn.jsonl`
- `training/data/natrual_filtered_v2/split/test_hn.jsonl`

Local answer-enriched files:

- `training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn-with-answer.jsonl`
- `training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn-with-answer.summary.json`
- `training/data/natrual_filtered_v2/split_with_answer/train_hn.jsonl`
- `training/data/natrual_filtered_v2/split_with_answer/eval_hn.jsonl`
- `training/data/natrual_filtered_v2/split_with_answer/test_hn.jsonl`
- `training/data/natrual_filtered_v2/split_with_answer/split_summary.json`

Local summaries:

- `training/data/natrual_filtered_v2/summary.json`
- `training/data/natrual_filtered_v2/split/split_summary.json`

### Hugging Face Repo

Published dataset:

- [Chrisyichuan/screenshot-training-natural-filtered-v2](https://huggingface.co/datasets/Chrisyichuan/screenshot-training-natural-filtered-v2)

Repo layout:

- `train.jsonl` / `train_hn.jsonl`
- `eval.jsonl` / `eval_hn.jsonl`
- `test.jsonl` / `test_hn.jsonl`
- `image_shards/`
- `extract_hf_image_shards.py`

The uploaded dataset is tar-sharded for reliability:

- `1000` image tar shards
- about `93.5 GB` total on Hugging Face

### Download

```bash
huggingface-cli download Chrisyichuan/screenshot-training-natural-filtered-v2 \
    --repo-type dataset \
    --local-dir data/screenshot-training-natural-filtered-v2

python data/screenshot-training-natural-filtered-v2/extract_hf_image_shards.py \
    --dataset-dir data/screenshot-training-natural-filtered-v2
```

### Reproduction Commands

#### 1. Query cleaning

```bash
uv run python clean_queries_simpleqa_style.py \
    --model gemini-2.0-flash-001 \
    --target-count 50000 \
    --batch-size 20 \
    --concurrency 8 \
    --dedupe-query \
    --output training/data/lite-query-v2-full-filtered-hn-v2-chunks/simpleqa_style_cleaned_50k.jsonl \
    --reviews-output training/data/lite-query-v2-full-filtered-hn-v2-chunks/simpleqa_style_cleaned_50k.reviews.jsonl \
    --summary-output training/data/lite-query-v2-full-filtered-hn-v2-chunks/simpleqa_style_cleaned_50k.summary.json
```

#### 2. Export strict retained rows

```bash
uv run python export_natural_filtered_v2.py \
    --reviews training/data/lite-query-v2-full-filtered-hn-v2-chunks/simpleqa_style_cleaned_50k.reviews.jsonl \
    --output-dir training/data/natrual_filtered_v2 \
    --output-name lite-query-v2-full-filtered-hn.jsonl \
    --min-naturalness 4 \
    --min-style-fit 4
```

#### 3. Split

```bash
uv run python split_first5_chunks.py \
    --inputs training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn.jsonl \
    --output-dir training/data/natrual_filtered_v2/split \
    --seed 42 \
    --train-ratio 0.9 \
    --eval-ratio 0.05 \
    --test-ratio 0.05
```

#### 3b. Attach answers and build `split_with_answer`

```bash
uv run python export_natural_filtered_v2_with_answer.py \
    --source-jsonl training/data/lite-query-v2-full-filtered.jsonl \
    --input-jsonl training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn.jsonl \
    --output-jsonl training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn-with-answer.jsonl \
    --summary-json training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn-with-answer.summary.json

uv run python split_first5_chunks.py \
    --inputs training/data/natrual_filtered_v2/lite-query-v2-full-filtered-hn-with-answer.jsonl \
    --output-dir training/data/natrual_filtered_v2/split_with_answer \
    --seed 42 \
    --train-ratio 0.9 \
    --eval-ratio 0.05 \
    --test-ratio 0.05
```

#### 4. Prepare and package for Hugging Face

```bash
uv run python prepare_hf_dataset.py \
    --split-dir training/data/natrual_filtered_v2/split \
    --image-root /opt/dlami/nvme/kiwix_tiles \
    --output-dir /opt/dlami/nvme/training_checkpoints/hf_dataset_export/screenshot-training-natural-filtered-v2 \
    --repo-id Chrisyichuan/screenshot-training-natural-filtered-v2

uv run python package_hf_image_shards.py \
    --source-dir /opt/dlami/nvme/training_checkpoints/hf_dataset_export/screenshot-training-natural-filtered-v2 \
    --output-dir /opt/dlami/nvme/training_checkpoints/hf_dataset_export_sharded/screenshot-training-natural-filtered-v2 \
    --overwrite

uv run python upload_hf_dataset.py \
    --repo-id Chrisyichuan/screenshot-training-natural-filtered-v2 \
    --local-dir /opt/dlami/nvme/training_checkpoints/hf_dataset_export_sharded/screenshot-training-natural-filtered-v2 \
    --repo-type dataset \
    --skip-create
```
