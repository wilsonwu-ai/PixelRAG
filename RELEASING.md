# Releasing PixelRAG to PyPI

PixelRAG ships as five packages, published together in lockstep:

| PyPI project | Source | Role |
| ------------ | ------ | ---- |
| `pixelrag` | repo root (`src/pixelrag`) | umbrella CLI + core (depends on `pixelrag-render`) |
| `pixelrag-render` | `render/` | the `pixelshot` command |
| `pixelrag-embed` | `embed/` | embed/chunk/build-index stages |
| `pixelrag-index` | `index/` | pipeline orchestrator |
| `pixelrag-serve` | `serve/` | search API |

`pixelrag-train` is a separate local project and is **not** published.

Publishing is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml)
using a single **account-scoped PyPI API token** stored as a repo secret.

## One-time setup

1. **Create an account-scoped PyPI API token** at
   <https://pypi.org/manage/account/token/> — scope **"Entire account"** (required so the
   token can create the new project names on first publish). Copy the `pypi-...` value.

2. **Store it as the `PYPI_API_TOKEN` repo secret:**

   ```bash
   gh secret set PYPI_API_TOKEN --repo StarTrail-org/PixelRAG
   ```

   (or repo Settings → Secrets and variables → Actions → New repository secret). One token
   publishes all five packages — no per-package configuration.

## Cutting a release

1. **Bump the version in all five packages** to the same `X.Y.Z`:

   ```bash
   for p in pixelrag pixelrag-render pixelrag-embed pixelrag-index pixelrag-serve; do
     uv version --package "$p" X.Y.Z
   done
   ```

   Keep them in lockstep — `pixelrag` depends on the others by name, and they are
   designed and tested as one version.

2. **Commit and push** the version bump.

3. **Publish a GitHub Release** with tag `vX.Y.Z` (matching the version). That fires
   `release.yml`, which builds and publishes all five packages to PyPI in parallel.

After it lands, `pip install pixelrag` gives `pixelshot` + the `pixelrag` umbrella;
`pip install 'pixelrag[serve]'` (or `[embed]`, `[index]`, `[all]`) adds the heavy stages.

## Dry run

Actions → **Release to PyPI** → Run workflow (leave `dry_run` checked) builds every
package and lists artifacts **without** uploading. Use it to sanity-check builds before a
real release.

## Notes

- **Lockstep versions.** All five share one version. The release workflow does not
  enforce tag == version; double-check before publishing (a dry run shows the built
  versions).
- **README images on PyPI.** The README uses repo-relative image paths
  (`docs/assets/...`), which render on GitHub but **not** on the PyPI project page. If you
  want them on PyPI, switch those `<img src>` to absolute `https://raw.githubusercontent.com/...`
  URLs.
- **sdist scope.** The repo root holds large data dirs (`.venv`, `tiles`, `arxiv`, …); the
  root package restricts its sdist to `src/pixelrag` + `README.md` + `LICENSE`
  (`[tool.hatch.build.targets.sdist]` in `pyproject.toml`). The sub-packages build from
  their own small directories.
