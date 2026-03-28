# Setup Typsite

GitHub Action to install the Typsite CLI and add it to `PATH`.

## Inputs

- `version` (optional): Version to install. Default: `latest`.
- `github-token` (optional): GitHub token for API requests. Defaults to `GITHUB_TOKEN` when available.

## Outputs

- `version`: The installed Typsite version (tag name).

## Usage

```yaml
jobs:
  setup:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: Glomzzz/setup-typsite@v1
        with:
          version: latest
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Notes

- Unauthenticated GitHub API requests are rate limited. If you hit rate limits, pass a token via `github-token`.
- This action downloads release assets from `Glomzzz/typsite` and selects the best match for the runner OS/arch.
- On Windows, it uses PowerShell `Expand-Archive`. On macOS/Linux, it uses `unzip`/`tar`.
- The action entrypoint is bundled into `dist/` using `@vercel/ncc`.
