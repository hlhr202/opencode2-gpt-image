import type { Plugin } from "@opencode/plugin"
import type { Info } from "@opencode/plugin/promise/tool"
import { v1CodexAuth, v2CodexAuth } from "./auth.js"
import { executionMode, resolveOptions, type Options } from "./config.js"
import { generateImage, resumeImageTask, v1Attachments, type GeneratedImage, type ImageArgs, type ImageRunDetails } from "./image.js"
import { IMAGE_MODELS } from "./models.js"

function description(backend: "api" | "codex", asyncMode: "sync" | "sub2api"): string {
  if (backend === "codex") {
    return "Generate or edit GPT images with ChatGPT OAuth (experimental, best effort). Uses gpt-image-2; sends count (1–4), size, quality, and transparent/opaque background to the Images endpoint. Upstream may return different values. PNG only; this plugin limits reference images to five and does not support masks or async tasks. Saves and attaches the actual files."
  }
  return `Generate or edit GPT images via Sub2API, CLIProxyAPI, or a compatible Images API. ` +
    (asyncMode === "sub2api"
      ? "Configured for Sub2API asynchronous submission and polling. The tool reports the task ID after acceptance; if polling stops, resume with gpt_image_task instead of submitting again. "
      : "Configured for synchronous image requests. ") +
    "Proxy/model support varies; unsupported requests are not automatically resubmitted. Saves and attaches the actual files."
}

const OUTPUT_DIR = "Destination relative to the invoking session directory, or absolute. Omit to use a self-gitignored .gpt-tmp directory."
const IMAGES = "Optional reference images: local paths relative to the session, file:// URIs, PNG/JPEG/WebP data URLs, or public HTTP URLs. When supplied, calls /images/edits."

function resultText(images: GeneratedImage[], details?: ImageRunDetails): string {
  const mode = details?.mode === "sub2api" ? `Sub2API async task ${details.taskID ?? "(ID unavailable)"} completed` :
    details ? `Synchronous ${details.backend === "codex" ? "Codex" : "API"} request completed` : "Task completed"
  return `${mode}. Saved ${images.length} image(s):\n${images.map((image) => `- ${image.path}`).join("\n")}` +
    (details?.reported ? `\nBackend reported: ${Object.entries(details.reported).map(([key, value]) => `${key}=${value}`).join(", ")}` : "") +
    (details?.notices.length ? `\nNotes:\n${details.notices.map((notice) => `- ${notice}`).join("\n")}` : "")
}

function resultMetadata(images: GeneratedImage[], model?: string, details?: ImageRunDetails) {
  return {
    ...(model ? { model } : {}), files: images.map((image) => image.path),
    ...(details ? { backend: details.backend, execution_mode: details.mode,
      ...(details.taskID ? { task_id: details.taskID } : {}), ...(details.reported ? { backend_reported: details.reported } : {}),
      ...(details.notices.length ? { notices: details.notices } : {}) } : {}),
  }
}

function v2Result(images: GeneratedImage[], model?: string, details?: ImageRunDetails) {
  return {
    content: [
      { type: "text" as const, text: resultText(images, details) },
      ...images.map(({ uri, mime, path }) => ({ type: "file" as const, uri, mime, name: path.split(/[\\/]/).at(-1)! })),
    ],
    metadata: resultMetadata(images, model, details),
  }
}

function v1Result(images: GeneratedImage[], model?: string, details?: ImageRunDetails) {
  return {
    title: `${images.length} GPT image(s) saved`,
    output: resultText(images, details),
    metadata: resultMetadata(images, model, details),
    attachments: v1Attachments(images),
  }
}

export function v2Tool(
  options: Options,
  directory: (sessionID: string) => Promise<string>,
  loadAuth: () => ReturnType<typeof v2CodexAuth>,
): Info {
  const { backend, asyncMode } = executionMode(options)
  const codex = backend === "codex"
  return {
    name: "gpt_image",
    description: description(backend, asyncMode),
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the image to generate." },
        model: { type: "string", enum: codex ? ["gpt-image-2"] : [...IMAGE_MODELS], description: codex ?
          "Codex best-effort backend currently only allows gpt-image-2." :
          "Official OpenAI Images API model ID. Defaults to plugin defaultModel (gpt-image-2). Proxy availability varies." },
        count: { type: "integer", minimum: 1, maximum: 4, description: "Request 1–4 images in one call; the backend may return fewer. Multiple paid calls are never made automatically." },
        size: { type: "string", description: codex ? "auto or WIDTHxHEIGHT; sent to Codex, but actual size may differ." : "auto or WIDTHxHEIGHT; support depends on model and proxy." },
        quality: { type: "string", enum: codex ? ["auto", "low", "medium", "high"] : ["auto", "low", "medium", "high", "xhigh", "max"],
          description: codex ? "Sent to Codex; actual quality may differ." : "xhigh and max require a GPT Image 2.5 model; proxy/model availability varies." },
        background: { type: "string", enum: ["auto", "opaque", "transparent"], description: "Transparent output requires PNG or WebP. GPT Image 2 transparency may be preview quality." },
        output_format: { type: "string", enum: codex ? ["png"] : ["png", "jpeg", "webp"], description: codex ? "Codex path only offers PNG; saved extension follows actual bytes." : "Requested format; saved extension follows actual bytes." },
        output_dir: { type: "string", description: OUTPUT_DIR },
        images: { type: "array", items: { type: "string" }, minItems: 1, maxItems: codex ? 5 : 16, description: IMAGES },
        ...(!codex ? { mask: { type: "string", description: "Optional local PNG path, file:// URI, or PNG data URL. Requires images. Proxy/model support varies." } } : {}),
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = input as ImageArgs
      await context.progress({ status: asyncMode === "sub2api" ? "Submitting Sub2API async image task" : "Generating GPT image synchronously" })
      let details: ImageRunDetails | undefined
      const images = await generateImage(args, await directory(context.sessionID), options, context.signal, loadAuth,
        (status) => context.progress({ status }), (value) => { details = value })
      return v2Result(images, args.model ?? resolveOptions(options).defaultModel, details)
    },
  }
}

export function v2TaskTool(options: Options, directory: (sessionID: string) => Promise<string>): Info {
  return {
    name: "gpt_image_task",
    description: "Resume polling an already-submitted Sub2API image generation or edit task by its task ID. Use the same proxy URL and API key; never resubmit blindly after a timeout. Saves the completed images.",
    input: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Sub2API image task ID (imgtask_...)." },
        output_dir: { type: "string", description: OUTPUT_DIR },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 1800, description: "Poll timeout in seconds; defaults to plugin taskTimeoutSeconds (1800)." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = input as { task_id: string; output_dir?: string; timeout_seconds?: number }
      const images = await resumeImageTask(args.task_id, await directory(context.sessionID), options,
        args.output_dir, args.timeout_seconds, context.signal, (status) => context.progress({ status }))
      return v2Result(images, undefined, { backend: "api", mode: "sub2api", taskID: args.task_id, notices: [] })
    },
  }
}

// V1 resolves its helper only when V1 calls server(). V2 never loads V1's runtime API.
async function server(input: { directory: string }, options: Options = {}): Promise<{ tool: Record<string, unknown> }> {
  const { tool } = await import("@opencode-ai/plugin")
  const z = tool.schema
  const { backend, asyncMode } = executionMode(options)
  const codex = backend === "codex"
  return {
    tool: {
      gpt_image: tool({
        description: description(backend, asyncMode),
        args: {
          prompt: z.string().describe("Description of the image to generate."),
          model: z.enum(codex ? ["gpt-image-2"] as const : IMAGE_MODELS).optional().describe(codex ?
            "Codex best-effort backend currently only allows gpt-image-2." :
            "Official OpenAI Images API model ID; defaults to plugin defaultModel (gpt-image-2). Proxy availability varies."),
          count: z.number().int().min(1).max(4).optional().describe("Request 1–4 images in one call; backend may return fewer. No automatic paid retries."),
          size: z.string().optional().describe(codex ? "auto or WIDTHxHEIGHT; sent to Codex, actual size may differ." : "auto or WIDTHxHEIGHT; support varies by model and proxy."),
          quality: z.enum(codex ? ["auto", "low", "medium", "high"] as const : ["auto", "low", "medium", "high", "xhigh", "max"] as const).optional().describe(codex ?
            "Sent to Codex; actual quality may differ." : "xhigh and max require a GPT Image 2.5 model; proxy/model support varies."),
          background: z.enum(["auto", "opaque", "transparent"]).optional().describe("Transparent output requires PNG or WebP; GPT Image 2 transparency is in preview."),
          output_format: z.enum(codex ? ["png"] as const : ["png", "jpeg", "webp"] as const).optional().describe(codex ?
            "Codex path only offers PNG; saved extension follows actual bytes." : "Requested format; saved extension follows actual bytes."),
          output_dir: z.string().optional().describe(OUTPUT_DIR),
          images: z.array(z.string()).min(1).max(codex ? 5 : 16).optional().describe(IMAGES),
          ...(!codex ? { mask: z.string().optional().describe("Optional local PNG path, file:// URI, or PNG data URL. Requires images. Proxy/model support varies.") } : {}),
        },
        async execute(args, context) {
          context.metadata?.({ title: asyncMode === "sub2api" ? "Submitting Sub2API async image task" : "Generating GPT image synchronously" })
          let details: ImageRunDetails | undefined
          const images = await generateImage(args as ImageArgs, context.directory || input.directory, options, context.abort, v1CodexAuth,
            (status) => context.metadata?.({ title: status }), (value) => { details = value })
          return v1Result(images, args.model ?? resolveOptions(options).defaultModel, details)
        },
      }),
      ...(!codex ? { gpt_image_task: tool({
        description: "Resume polling an already-submitted Sub2API image generation or edit task by task ID. Use the same proxy and API key. Never resubmit blindly after a timeout.",
        args: {
          task_id: z.string().describe("Sub2API image task ID (imgtask_...)."),
          output_dir: z.string().optional().describe(OUTPUT_DIR),
          timeout_seconds: z.number().int().min(1).max(1800).optional(),
        },
        async execute(args, context) {
          const images = await resumeImageTask(args.task_id, context.directory || input.directory, options,
            args.output_dir, args.timeout_seconds, context.abort, (status) => context.metadata({ title: status }))
          return v1Result(images, undefined, { backend: "api", mode: "sub2api", taskID: args.task_id, notices: [] })
        },
      }) } : {}),
    },
  }
}

const GptImagePlugin = {
  id: "gpt-image",
  async setup(ctx: Plugin.Context) {
    const directory = async (sessionID: string) => (await ctx.session.get({ sessionID })).location.directory
    await ctx.tool.transform((editor) => {
      editor.add(v2Tool(ctx.options as Options, directory, async () => v2CodexAuth(ctx.integration.connection)))
      if (executionMode(ctx.options as Options).backend === "api") editor.add(v2TaskTool(ctx.options as Options, directory))
    })
  },
  server,
}

export default GptImagePlugin
