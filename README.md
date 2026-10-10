# opencode2-gpt-image

GPT Image generation for **OpenCode 1.18.29+ and OpenCode 2**. The primary backend is the OpenAI-compatible Images API exposed by **Sub2API / CLIProxyAPI** (or a compatible image proxy). ChatGPT subscription generation via the Codex Images endpoint is experimental and opt-in.

The plugin adds `gpt_image` (generate or edit) and `gpt_image_task` (resume an existing Sub2API image task). Your chat model must support calling tools; the image model is chosen *inside* the tool, not in the chat model picker.

## Install and configure

Both OpenCode versions use the same plugin options. For the API backend, set `baseURL` and `apiKey` in the options; `baseURL` accepts a URL with or without `/v1`. The chat provider's API key is not inherited. `insecureTLS: true` disables certificate verification for this plugin's API requests (including task polling and image URL downloads); `false` uses normal certificate checks. It does not change TLS behavior for the experimental Codex backend or other plugins.

**OpenCode 2** (`opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "opencode2-gpt-image",
    "options": {
      "backend": "api",
      "baseURL": "https://your-proxy.example.com/v1",
      "apiKey": "your-key",
      "insecureTLS": false,
      "defaultModel": "gpt-image-2",
      "asyncMode": "sync",
      "taskTimeoutSeconds": 1800
    }
  }]
}
```

**OpenCode 1.18.29+** (`opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["opencode2-gpt-image", {
    "backend": "api",
    "baseURL": "https://your-proxy.example.com/v1",
    "apiKey": "your-key",
    "insecureTLS": false,
    "defaultModel": "gpt-image-2",
    "asyncMode": "sync",
    "taskTimeoutSeconds": 1800
  }]]
}
```

| Plugin option | Default | Effect |
| --- | --- | --- |
| `backend` | `"api"` | `"api"` (Sub2API/CLIProxyAPI) or opt-in `"codex"`. |
| `baseURL` | none | Proxy base URL, with or without `/v1`; required for API backend. |
| `apiKey` | none | Proxy API key; required for API backend. |
| `insecureTLS` | `false` | `true` disables certificate checks for API backend image requests; per-plugin, not process-wide. |
| `defaultModel` | `"gpt-image-2"` | Official OpenAI Images API model ID used when `model` is omitted. |
| `asyncMode` | `"sync"` | `"sub2api"` enables async submissions by default; `"sync"` uses synchronous endpoints. |
| `taskTimeoutSeconds` | `1800` | Async submit-and-poll and `gpt_image_task` timeout; integer from 1 to 1800. |

For all seven options, an explicit plugin value takes precedence over the equivalent server environment variable (`GPT_IMAGE_BACKEND`, `GPT_IMAGE_BASE_URL`, `GPT_IMAGE_API_KEY`, `GPT_IMAGE_INSECURE_TLS`, `GPT_IMAGE_DEFAULT_MODEL`, `GPT_IMAGE_ASYNC_MODE`, `GPT_IMAGE_TASK_TIMEOUT_SECONDS`); `CPA_BASE_URL` and `CPA_API_KEY` are last-resort connection fallbacks. The three request defaults `defaultModel`, `asyncMode`, and `taskTimeoutSeconds` can be overridden per tool call with `model`, `async_mode` (including `false`), and `timeout_seconds`. `insecureTLS` accepts a boolean in plugin options; its environment equivalent accepts `true`/`false` or `1`/`0`. Restart the backend after changing plugin configuration. Sub2API requires an OpenAI-capable group for its Images API; model availability and supported options depend on the proxy and upstream account.

## Use

Ask the agent to call `gpt_image` with a `prompt`; for example: “Generate a blue crane illustration with `gpt_image`, save it under `assets/images`.” To edit: “Call `gpt_image` with `images: ["assets/images/crane.png"]` and change its background to blue.” Set `mask` to a local PNG path or PNG data URL for masked editing where the proxy supports it.

| Argument | Behavior |
| --- | --- |
| `prompt` | Required image description. |
| `model` | Official OpenAI Images API model ID; defaults to plugin `defaultModel` (`gpt-image-2`). |
| `count` | 1–4 images per request; default determined by upstream (normally one). |
| `size` | `auto` or `WIDTHxHEIGHT`; actual supported sizes depend on model and upstream. |
| `quality` | `auto`, `low`, `medium`, `high`; `xhigh` and `max` only for GPT Image 2.5 models. |
| `background` | `auto`, `opaque`, `transparent`. Transparent output requires PNG or WebP. |
| `output_format` | `png`, `jpeg`, `webp`; the actual response signature determines the saved extension. |
| `output_dir` | Absolute or relative to the invoking session directory. Omit to save under a self-gitignored `.gpt-tmp/`. |
| `images` | 1–16 local file paths, `file://` URIs, PNG/JPEG/WebP data URLs, or public HTTP URLs. When set, sends a JSON request with `images[].image_url` to `/v1/images/edits`. Local files are inlined as data URLs. |
| `mask` | Optional local PNG file, `file://` URI, or PNG data URL; requires `images`. |
| `async_mode` | Overrides plugin `asyncMode`; `true` uses Sub2API's `/v1/images/generations/async` or `/v1/images/edits/async`, then polls. `false` forces synchronous calls. |
| `timeout_seconds` | Async polling timeout, 1–1800 seconds; defaults to plugin `taskTimeoutSeconds` (1800). Only valid when async is effective. |

Model names follow the [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate), without proxy aliases or provider prefixes: `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare`, `gpt-image-2.5-flare-2026-09-08`, and `chatgpt-image-latest`. The older `dall-e-*` models are retired and intentionally excluded. An official ID does **not** imply that your proxy provides it; the plugin never silently renames or falls back to another model.

The plugin supports **synchronous generation and reference-image edits** through `POST /v1/images/generations` and `POST /v1/images/edits`. Successful calls report saved paths and attach the actual files. Failed or empty responses do not report a generated image. Individual proxies may support a smaller subset of model IDs, options, image formats, or reference counts; unsupported requests return their errors rather than silently changing the selected model.

### Sub2API asynchronous image tasks

Set `asyncMode: "sub2api"` in plugin options to default to long-running **generation or edit** tasks, or set `async_mode: true` on a single tool call. This uses the same JSON image payload, expects Sub2API to accept it with HTTP `202`, and polls `GET /v1/images/tasks/{task_id}` using the **same API key**. On success it downloads the returned object-storage URL and saves the image as usual. The proxy's `Retry-After` header controls the polling delay. This is specific to Sub2API; leave `asyncMode: "sync"` for CLIProxyAPI unless its deployment explicitly implements the same protocol.

Sub2API's [async image task documentation](https://github.com/wei-shaw/sub2api/blob/main/docs/ASYNC_IMAGE_TASKS.md) says the feature is **disabled by default**: its operator must configure and enable async image object storage (S3-compatible storage) and use an OpenAI-capable group. A disabled endpoint returns 404, which the plugin reports as a configuration issue. Polling does not switch to synchronous mode, and generation is not silently resubmitted.

If polling is interrupted or times out, the error includes the task ID when known. **Do not repeat the paid `gpt_image` submission.** Call `gpt_image_task` with `task_id` to resume polling the existing task, using the same proxy URL and API key; it accepts optional `output_dir` and `timeout_seconds` (otherwise uses `taskTimeoutSeconds`). Tasks expire at the upstream provider's discretion (Sub2API currently documents 24 hours after the latest state update). A client timeout does not prove the remote task failed.

## Experimental ChatGPT/Codex subscription backend

To opt in, set `backend: "codex"` in plugin options, or `GPT_IMAGE_BACKEND=codex` in the server environment. This path calls `https://chatgpt.com/backend-api/codex/images/generations` or `/images/edits` and requires a ChatGPT Codex OAuth login; it **does not use** `baseURL` or `apiKey`. OpenCode 2 resolves the active OpenAI integration; OpenCode 1 reads its own `OPENCODE_AUTH_CONTENT` or XDG `opencode/auth.json` credential. Token-sharing integrations are unsupported.

Only `gpt-image-2`, one PNG per call, and opaque/transparent backgrounds are offered on this path. Reference images use the Codex edits endpoint (up to five), but masks and `async_mode` are unavailable. Requested sizes are hints, not guarantees. The Codex endpoint is an unofficial, changing backend and is **best effort**. It is not a fallback for a failed proxy request and does not imply that a ChatGPT subscription grants image API access through Sub2API/CLIProxyAPI. See the upstream [migration investigation](https://github.com/yuji-hatakeyama/opencode-gpt-imagegen/issues/107).

## Develop and publish

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

CI runs these checks on `main` and pull requests. The initial `v0.1.0` was submitted to npm by a one-time GitHub Actions bootstrap workflow using an npm token; that workflow has been removed from `main` after release. Before the **next release**, configure **npm Trusted Publishing** for GitHub user `hlhr202`, repository `opencode2-gpt-image`, workflow filename `publish.yml` (allow direct `npm publish`), and remove the one-time `NPM_BOOTSTRAP_TOKEN` repository secret. Subsequent stable `v<package.json version>` tags use `.github/workflows/publish.yml` with GitHub OIDC, without a publishing token. The release workflow verifies that each tag matches `package.json`. Tests mock network calls and do not spend image credits; real proxy and OpenCode installation compatibility remain unverified until tested against deployed services.

MIT licensed.
