import type { Plugin } from "@opencode/plugin"
import type { Info } from "@opencode/plugin/promise/tool"
import { v1CodexAuth, v2CodexAuth } from "./auth.js"
import { resolveOptions, type Options } from "./config.js"
import { generateImage, resumeImageTask, v1Attachments, type GeneratedImage, type ImageArgs } from "./image.js"
import { IMAGE_MODELS } from "./models.js"

const DESCRIPTION = "Generate or edit GPT Image pictures using Sub2API, CLIProxyAPI, or another OpenAI-compatible Images API. Provide images for reference-guided editing, optionally a PNG mask. Set async_mode for Sub2API long-running tasks; use gpt_image_task to resume polling after a timeout. Saves the actual returned image files. The optional Codex backend uses ChatGPT OAuth on a best-effort basis; it supports only gpt-image-2 and one PNG per call."

const OUTPUT_DIR = "Destination relative to the invoking session directory, or absolute. Omit to use a self-gitignored .gpt-tmp directory."
const IMAGES = "Optional reference images (1–16): local paths relative to the session, file:// URIs, PNG/JPEG/WebP data URLs, or public HTTP URLs. When supplied, calls /images/edits."
const ASYNC_MODE = "Use Sub2API's asynchronous image task endpoint and poll for completion. Requires async image object storage enabled on the proxy; not for CLIProxyAPI or direct Codex."

function v2Result(images: GeneratedImage[], model?: string) {
  return {
    content: [
      { type: "text" as const, text: `Saved ${images.length} image(s):\n${images.map((image) => `- ${image.path}`).join("\n")}` },
      ...images.map(({ uri, mime, path }) => ({ type: "file" as const, uri, mime, name: path.split(/[\\/]/).at(-1)! })),
    ],
    metadata: { ...(model ? { model } : {}), files: images.map((image) => image.path) },
  }
}

function v1Result(images: GeneratedImage[], model?: string) {
  return {
    title: `${images.length} GPT image(s) saved`,
    output: `Saved ${images.length} image(s):\n${images.map((image) => `- ${image.path}`).join("\n")}`,
    metadata: { ...(model ? { model } : {}), files: images.map((image) => image.path) },
    attachments: v1Attachments(images),
  }
}

export function v2Tool(
  options: Options,
  directory: (sessionID: string) => Promise<string>,
  loadAuth: () => ReturnType<typeof v2CodexAuth>,
): Info {
  return {
    name: "gpt_image",
    description: DESCRIPTION,
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the image to generate." },
        model: { type: "string", enum: [...IMAGE_MODELS], description: "Official OpenAI Images API model ID. Defaults to the plugin's defaultModel (gpt-image-2). Proxy availability varies." },
        count: { type: "integer", minimum: 1, maximum: 4, description: "Number of images (default 1)." },
        size: { type: "string", description: "auto or WIDTHxHEIGHT; support depends on model and proxy." },
        quality: { type: "string", enum: ["auto", "low", "medium", "high", "xhigh", "max"] },
        background: { type: "string", enum: ["auto", "opaque", "transparent"] },
        output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
        output_dir: { type: "string", description: OUTPUT_DIR },
        images: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16, description: IMAGES },
        mask: { type: "string", description: "Optional local PNG path, file:// URI, or PNG data URL. Requires images." },
        async_mode: { type: "boolean", description: `${ASYNC_MODE} Overrides plugin asyncMode; false forces synchronous mode.` },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 1800, description: "Sub2API task polling timeout; defaults to plugin taskTimeoutSeconds (1800). Only with async mode." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = input as ImageArgs
      await context.progress({ status: "Generating GPT image" })
      const images = await generateImage(args, await directory(context.sessionID), options, context.signal, loadAuth,
        (status) => context.progress({ status }))
      return v2Result(images, args.model ?? resolveOptions(options).defaultModel)
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
      return v2Result(images)
    },
  }
}

// V1 resolves its helper only when V1 calls server(). V2 never loads V1's runtime API.
async function server(input: { directory: string }, options: Options = {}): Promise<{ tool: Record<string, unknown> }> {
  const { tool } = await import("@opencode-ai/plugin")
  const z = tool.schema
  return {
    tool: {
      gpt_image: tool({
        description: DESCRIPTION,
        args: {
          prompt: z.string().describe("Description of the image to generate."),
          model: z.enum(IMAGE_MODELS).optional().describe("Official OpenAI Images API model ID; defaults to plugin defaultModel (gpt-image-2)."),
          count: z.number().int().min(1).max(4).optional(),
          size: z.string().optional().describe("auto or WIDTHxHEIGHT; support varies by model and proxy."),
          quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
          background: z.enum(["auto", "opaque", "transparent"]).optional(),
          output_format: z.enum(["png", "jpeg", "webp"]).optional(),
          output_dir: z.string().optional().describe(OUTPUT_DIR),
          images: z.array(z.string()).min(1).max(16).optional().describe(IMAGES),
          mask: z.string().optional().describe("Optional local PNG path, file:// URI, or PNG data URL. Requires images."),
          async_mode: z.boolean().optional().describe(`${ASYNC_MODE} Overrides plugin asyncMode; false forces synchronous mode.`),
          timeout_seconds: z.number().int().min(1).max(1800).optional().describe("Sub2API polling timeout; defaults to plugin taskTimeoutSeconds (1800). Only with async mode."),
        },
        async execute(args, context) {
          const images = await generateImage(args, context.directory || input.directory, options, context.abort, v1CodexAuth,
            (status) => context.metadata({ title: status }))
          return v1Result(images, args.model ?? resolveOptions(options).defaultModel)
        },
      }),
      gpt_image_task: tool({
        description: "Resume polling an already-submitted Sub2API image generation or edit task by task ID. Use the same proxy and API key. Never resubmit blindly after a timeout.",
        args: {
          task_id: z.string().describe("Sub2API image task ID (imgtask_...)."),
          output_dir: z.string().optional().describe(OUTPUT_DIR),
          timeout_seconds: z.number().int().min(1).max(1800).optional(),
        },
        async execute(args, context) {
          const images = await resumeImageTask(args.task_id, context.directory || input.directory, options,
            args.output_dir, args.timeout_seconds, context.abort, (status) => context.metadata({ title: status }))
          return v1Result(images)
        },
      }),
    },
  }
}

const GptImagePlugin = {
  id: "gpt-image",
  async setup(ctx: Plugin.Context) {
    const directory = async (sessionID: string) => (await ctx.session.get({ sessionID })).location.directory
    await ctx.tool.transform((editor) => {
      editor.add(v2Tool(ctx.options as Options, directory, async () => v2CodexAuth(ctx.integration.connection)))
      editor.add(v2TaskTool(ctx.options as Options, directory))
    })
  },
  server,
}

export default GptImagePlugin
