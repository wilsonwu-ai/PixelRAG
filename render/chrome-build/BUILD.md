# Building the patched `headless_shell`

`pixelshot`'s **turbo** capture path (`fast_cdp`, used when `--turbo` / a turbo-capable
Chrome is selected) relies on three custom CDP additions that are **not** in upstream
Chromium. They are provided by a small patch on top of a stock Chromium checkout, built
into a `headless_shell` binary that `pixelshot install-chrome` downloads.

Without this binary, `pixelshot` still works — it falls back to the portable standard
capture path (in-Chrome JPEG over CDP), which runs on any stock Chrome. The patched
binary only adds throughput (≈2× at batch scale); see
`docs/internal/screenshot-optimization-notes.md`.

## What the patch adds

`pixelrag-chrome.patch` (5 files, ~265 insertions) adds to `Page.captureScreenshot`:

| Feature | Effect |
|---|---|
| `rawFilePath` | Async-write raw BGRA to a file (skips in-Chrome PNG/JPEG encoding) |
| `directClip` | `CopyFromSurface(src_rect)` without an emulation change (parallel tile capture) |
| `skipRedraw` / `ForceRedrawWithCallback` | Lightweight ForceRedraw with a commit callback |

The patch touches only cross-platform DevTools/compositor code — there are **no**
platform `#if`s — so it applies and builds on Linux, macOS, and Windows alike.

## Base

- Chromium **150** (`CHROME_VERSION` in `render/src/pixelrag_render/chrome.py`)
- Patch base commit: `4deaeccb7c` (upstream); the patch is `git diff` from that base.

## Build (any platform — run on a host of that OS)

Prerequisites: [`depot_tools`](https://chromium.googlesource.com/chromium/tools/depot_tools)
on `PATH`, a Chromium checkout at the base above, ~100 GB free disk, and the platform
toolchain (Linux: clang via `runhooks`; macOS: Xcode; Windows: VS/MSVC).

```bash
# 1. fetch deps for the checkout
gclient sync --with_branch_heads --with_tags --delete_unversioned_trees -j 32
gclient runhooks

# 2. apply the patch
git -C src apply ../render/chrome-build/pixelrag-chrome.patch     # or: git am / patch -p1

# 3. configure (headless, optimized) and build
mkdir -p src/out/Headless
cat > src/out/Headless/args.gn <<'EOF'
import("//build/args/headless.gn")
is_official_build = true
is_debug = false
symbol_level = 0
blink_symbol_level = 0
chrome_pgo_phase = 0
EOF
( cd src && gn gen out/Headless && autoninja -C out/Headless headless_shell )
```

`gn` builds for the **host** OS/arch by default, so running this on macOS produces a
macOS binary, on Windows a Windows binary. `args.gn` is identical across platforms
(`headless.gn` is cross-platform).

### Per-platform notes

- **linux-x64** — current release target; ~1–2 h on a many-core box.
- **macOS (arm64/x64)** — build on macOS. The unsigned `headless_shell` is blocked by
  Gatekeeper; **codesign + notarize** before distributing (Apple Developer account), or
  users must clear the quarantine attribute manually.
- **Windows (x64)** — build on Windows with the VS toolchain; ship `headless_shell.exe`
  plus its runtime DLLs/`.pak`.

## Release

`pixelshot install-chrome` downloads from
`releases/download/chrome-<version>/headless_shell-<platform>.tar.zst`. Today only
`headless_shell-linux-x64` is published; add `darwin-arm64`, `darwin-x64`, `win-x64`
assets to give those platforms the turbo path. `chrome.py` currently hard-stops
auto-install on non-linux-x64 — extend `RELEASE_URL_TEMPLATE` / the platform guard when
those assets exist.

The CI workflow `.github/workflows/chrome-build.yml` runs this recipe on self-hosted
runners (hosted runners can't fit a full Chromium build).
