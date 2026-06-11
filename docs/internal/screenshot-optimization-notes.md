# Screenshot Throughput Optimization — Working Progress

## Target: 150 t/s @ 100% correct (8192px tiles, maxi Wikipedia)

## Current Best

| Config | t/s | Correct | Notes |
|--------|-----|---------|-------|
| multi-process 48w (frameStoppedLoading) | **91** | 100% ✓ | Stable, production-ready |
| multi-process 48w (frameNavigated) | **98** | 100% ✓ | Stable (igpu incompatible) |
| multi-process 48w (2000 art) | **113** | 99.8% ✓ | Steady-state |
| igpu 48w + frameStoppedLoading | **117-132** | 90-97% | Fast but 3-10% about:blank |
| igpu 48w + directClip | **128-148** | 48-90% | Fastest, worst correctness |

## Production System Comparison

The wiki-screenshot production system (`~/pixelrag-src/wiki-screenshot/`) uses:
```python
wait_fonts = False    # for kiwix/ZIM datasource
wait_images = False   # for kiwix/ZIM datasource
pre_screenshot_delay = 0.5  # fixed 500ms sleep, no fonts.ready
```
- Playwright-based (not CDP websocket)
- GPU-accelerated (8× L40S per machine)
- Multi-machine: 4 machines × ~70-80 t/s = ~290 t/s total
- Full Wikipedia (8.28M articles) processed in ~1 day

Our optimizations added `fonts.ready + eager images + double-rAF` for pixel-perfect
correctness. Production skips these waits entirely (`pre_screenshot_delay=0` in
coordinator). This is safe for Kiwix because all assets (including fonts) are served
from localhost — they load before `wait_until="load"` fires.

Gemini Vision validation of 5000 production tiles:
- 0% BROKEN_RENDER, 0% ERROR_PAGE (rendering is correct without font wait)  
- 12% BLANK/PARTIAL_BLANK (tile loop overshoots page height — separate bug)

**Benchmark result**: Removing font/image wait gives only +4% throughput (99 vs 96 t/s)
because nav is not the bottleneck — capture IPC is. The 290 t/s production rate comes
from 4 machines × GPU acceleration, not from skipping font waits.

## Pipeline Bottleneck Analysis

```
Stage         Capacity    Bottleneck?
Nav           430 pg/s    No (3.4x headroom)
Capture       125 t/s     YES (C/T_c = 48/321ms)

Steady-state theoretical: 125-150 t/s
Actual (200 art): 98 t/s (75% utilization, 25% = nav serial)
Actual (2000 art): 113 t/s (85% utilization)
```

Per-capture breakdown at 48 concurrent:
- IPC roundtrip: 181ms (ForceRedraw browser→renderer→compositor, 8 async hops)
- DrawRenderPass: 62ms (composite 136 quads)
- CopyDrawnRenderPass: 46ms (memcpy 28MB)

Throughput = `C / T_c(C)` converges at ~125-130 t/s (USL contention curve).
Nav latency (186ms) does not affect steady-state throughput (Little's Law).
Minimum workers to saturate capture: `C × (1 + T_nav/T_cap) = 72`.

## Chromium Patches (in custom build)

| Patch | File | Impact |
|-------|------|--------|
| rawFilePath | page_handler.cc + Page.pdl | Async write raw BGRA to /dev/shm (ThreadPool) |
| directClip | page_handler.cc + Page.pdl | CopyFromSurface(src_rect) without emulation change |
| skipRedraw | page_handler.cc + Page.pdl | ForceRedrawWithCallback → CopyFromSurface |
| ForceRedrawWithCallback | render_widget_host_impl.cc | Lightweight ForceRedraw with commit callback |
| directClip ForceRedraw fix | page_handler.cc | directClip also does ForceRedraw before copy |

## Strategy Architecture

Strategies separated from bench framework:
- `pixelrag_render.strategies/` — capture strategies (CDPPhased, CDPSequential, etc.)
- `pixelrag_render.bench/` — measurement harness with GT validation + experiment dump
- `Bench` class: `bench.run(strategy)` → GT cache + capture + verify + JSON dump

### CDPPhasedStrategy (best strategy)
- Work-stealing queue (asyncio.Queue, not round-robin)
- Semaphore-limited concurrent captures
- `wait_for_event("Page.frameStoppedLoading")` filtered by main frameId
- Per-tile semaphore release (fine-grained pipelining)
- Configurable: tile_height, nav_timeout, use_direct_clip, extra_chrome_args

### WebsocketConnection
- Background `_recv_loop` for multiplexed CDP
- `wait_for_event(method, timeout, filter_fn)` for async event listening
- Supports concurrent `cdp()` calls via pending futures dict

## What Was Tried

### Worked
- ✅ rawFilePath: async write bypasses PNG encoding (+15%)
- ✅ directClip: parallel tile capture within viewport
- ✅ Phased strategy: semaphore-limited captures reduce contention (+15%)
- ✅ Work-stealing queue: better load balancing
- ✅ frameNavigated/frameStoppedLoading wait: fixes igpu about:blank race
- ✅ Presentation feedback ForceRedraw: 100% correct (but slower)

### Partially Worked
- ⚠️ --in-process-gpu: 120+ t/s but 5-10% about:blank captures
- ⚠️ SwapPromise ForceRedraw: shot_p50 325→303ms (7% gain)
- ⚠️ directClip for all tiles: fast but correctness depends on ForceRedraw

### Did Not Work
- ❌ --single-process: 168 t/s but 74% correct
- ❌ peekPixels (SkiaRenderer): headless uses SoftwareRenderer
- ❌ Immediate BeginFrame feedback flush: breaks frame pipeline
- ❌ CDPScreenshotNewSurface: RequestRepaintOnNewSurface overhead
- ❌ 2-tab pipelining: Chrome UI thread serializes ForceRedraw
- ❌ Chrome flags (disable-lcd-text etc.): ±2%
- ❌ headless_shell: slower than chrome (no shared HTTP cache)
- ❌ One-shot strategy: launch overhead 1-2s/process
- ❌ Firefox Playwright: 2.6x slower than Chrome
- ❌ Servo (servoshell 0.1.0): stub package, not ready
- ❌ CEF (cefpython3): abandoned, no modern Python wheel
- ❌ WebKitGTK snapshot: needs GPU/display access
- ❌ RequestRepaintOnNewSurface in skipRedraw: didn't fix igpu race
- ❌ Bitmap dimension retry: about:blank renders at full viewport size
- ❌ Pixel content retry: can't distinguish white page from about:blank

## igpu About:blank Root Cause

Chrome `--in-process-gpu` has two bugs at 48 concurrent workers:
1. **frameNavigated event not fired**: Chrome sometimes silently drops
   `Page.frameNavigated` CDP event under high concurrency. 
   Fix: use `Page.frameStoppedLoading` (always reliable).
2. **Compositor surface race**: ForceRedraw's presentation feedback arrives
   before the new page's CompositorFrame is activated in viz. CopyFromSurface
   reads the old surface (about:blank at 875×8192, indistinguishable from
   real page by dimensions). No reliable Python-side detection possible.

## Key Analysis Methods Used

- **Pipeline bottleneck analysis** (closed queueing model)
- **Little's Law**: steady-state throughput = C/T_c when capture-bound
- **USL contention curve**: C/T_c(C) convergence at ~125-130 t/s
- **USE method**: Utilization (79%), Saturation (semaphore queue), Errors (0)
- **Per-capture breakdown**: DrawRenderPass (57ms) + CopyDrawnRenderPass (18ms)
  + IPC overhead (95ms) measured via Chromium instrumentation

## Scale Estimate

30M tiles (18.7M articles × ~1.6 tiles/article):
- Single machine 98 t/s: 30M/98 = 85 hours = **3.5 days**
- Single machine 120 t/s (igpu, 95% correct): 30M/120 = 69 hours = **2.9 days**
- 4 machines × 98 t/s = 392 t/s: 30M/392 = 21 hours = **< 1 day**
- Production system (290 t/s, 4 machines): ~1 day (matches historical data)

## Production Pipeline: fast_cdp backend

```
Chrome 48w (capture)  →  /dev/shm (raw BGRA)  →  ProcessPool 4w (JPEG)  →  disk
     98 t/s                 28MB/tile               ~100 t/s                100KB/tile
```

Architecture:
- `render_articles()` in `pixelrag_render.backends.fast_cdp`
- Capture: CDPPhasedStrategy logic (work-stealing, semaphore, frameStoppedLoading)
- Compression: `concurrent.futures.ProcessPoolExecutor(4)` — GIL-free, separate cores
- Raw files in /dev/shm/pixelrag_render/ — auto-deleted after compression
- Output: JPEG tiles + tiles.json manifest per article

Key: compression never blocks capture. Chrome writes raw → returns immediately.
Compression reads raw file asynchronously on different CPU cores.

128-core machine: 48 cores for Chrome, 4 cores for JPEG, 76 cores idle.
JPEG compression of 875×8192 takes ~10-20ms → 4 cores handle 200-400 t/s → 
plenty of headroom over 98 t/s capture rate.

Storage: 30M tiles × 100KB JPEG = ~3 TB

## GPU Acceleration (Brewster H200 findings)

Lab machines have 8× H200/B200 GPUs but:
- `/dev/dri/renderD*` needs `render` group membership (no sudo)
- Docker daemon not running; rootless docker lacks nvidia-container-toolkit
- SwiftShader (CPU Vulkan) doesn't improve throughput vs software rendering
- headless Chrome ignores `--use-gl` flags (GPU process crashes on init)
- When GPU DOES init (via Xvfb + ANGLE), missing NVIDIA userspace drivers in container

To unlock GPU: `sudo usermod -aG render $USER` on lab machine.
Expected impact: 4x faster DrawRenderPass based on production system data.

## Backend reconciliation & SPA-render fix (2026-06-11)

### The three render code paths (who actually runs what)
- `backends/websocket.py` — the **shipped** general-purpose renderer. The `pixelshot`
  CLI, the `pixelbrowse` skill, and the `pixelrag index` pipeline (`render_urls`,
  `backend="cdp"`/`"websocket"`) all go through it. Simple: per-worker queue, inline
  JPEG over CDP, no extra deps.
- `backends/fast_cdp.py` — high-throughput batch path (`render_articles`): phased-logic
  capture + rawFilePath to /dev/shm + ProcessPool JPEG. **No in-repo caller** — invoked
  only by an out-of-repo ops script. The 8.28M flagship Wikipedia index was built by a
  *separate* system (Playwright/GPU/4-machine, see "Production System Comparison"), not
  by either of these.
- `strategies/*` — the benchmarking menu; used only by `bench/`. Kept as research scaffolding.

### Regression fixed: websocket backend rendered SPAs / tall pages wrong
`backends/websocket.py` had drifted from the established capture pattern — it had **no
nav-completion wait** (fired `document.fonts.ready` immediately after `Page.navigate`)
and **no per-tile scroll**, both of which `fast_cdp` and the production strategies have.
Consequences:
- JS/SPA pages were measured/captured mid-hydration at a transient (often much taller)
  layout → tiled into mostly-empty space = blank tiles (this is the "tile loop overshoots
  page height" blank bug noted under "Production System Comparison", here root-caused).
- At small `tile_height` (the skill uses 1568) every tile past the first was blank,
  because content below the short device viewport is never rasterized without scrolling.

Fix (verified in `bench/` against ground truth at 100% on the smoke set):
- Wait for the `load` event before measuring/capturing (`readyState==='complete'`
  shortcut + 12s cap). SSR pages fire `load` ~as fast as `fonts.ready`, so ~0 cost
  (measured: Wikipedia render time unchanged).
- Scroll each tile into view before capture (mirrors `fast_cdp`).
- Optional `--wait-network-idle` (JS PerformanceObserver) for pages that fetch content
  after load; off by default (costs a quiet window/page), on by default in the skill.

### Raw vs inline-JPEG is the dominant throughput lever (measured, 48w, N=600, this box)
| config | correct | t/s | note |
|---|---|---|---|
| phased **raw** (fast_cdp config) | 99.7% | **306** | capture-only in bench; JPEG is decoupled/parallel |
| phased jpeg (inline) | 98.2% | 182 | Chrome encodes JPEG on the capture critical path |
| sequential raw | 99.7% | 221 | |
| sequential jpeg (inline) | 98.2% | 142 | |

Takeaways: (1) **inline JPEG encoding is the bottleneck** — bypassing it with rawFilePath
+ parallel compression is ~+56-68%. (2) phased's semaphore/work-stealing buys ~+38% over
sequential **in raw mode** (in jpeg mode the encoding bottleneck masks it to ~+8% — an
earlier jpeg-only comparison was misleading). So `fast_cdp` is ~2x the simple inline path
at batch scale and is **kept**. Absolute t/s here is optimistic (capture-only, short
window, 128-core box) vs the ~91-113 production figure; the *ratios* are the point.

### Design direction
Ship **one simple backend** (`websocket.py`, inline JPEG) for the CLI/skill/`pixelrag index`
— that scale doesn't need the raw+decoupled machinery, and the flagship index uses the
separate system anyway. Keep `fast_cdp` + `strategies/` as batch/research code. The shared
capture-readiness logic (load wait, scroll) should eventually live in one place so the
shipped backend can't silently drift from the correct pattern again.
