import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { imageEndpoint, resolveOptions, type Options, type ResolvedOptions } from "./config.js"
import { modelName } from "./models.js"
import { createTransport, type ImageTransport } from "./transport.js"

export interface ImageArgs {
  prompt: string
  model?: string
  count?: number
  size?: string
  quality?: "auto" | "low" | "medium" | "high" | "xhigh" | "max"
  background?: "auto" | "opaque" | "transparent"
  output_format?: "png" | "jpeg" | "webp"
  output_dir?: string
  images?: string[]
  mask?: string
  async_mode?: boolean
  timeout_seconds?: number
}

export interface GeneratedImage {
  path: string
  mime: string
  uri: string
}

export interface CodexAuth {
  access: string
  accountId?: string
}

export type AuthLoader = () => Promise<CodexAuth | undefined>

type ImageResponse = { data?: { b64_json?: string; b64?: string; url?: string }[] }
type TaskResponse = {
  id?: string
  task_id?: string
  status?: string
  result?: ImageResponse
  error?: { message?: string }
  http_status?: number
}

function imageType(bytes: Buffer): { mime: string; ext: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { mime: "image/png", ext: ".png" }
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return { mime: "image/jpeg", ext: ".jpg" }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: ".webp" }
  }
  throw new Error("Image endpoint returned unsupported or invalid image bytes")
}

function validate(args: ImageArgs): void {
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt is required")
  modelName(args.model)
  if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > 4)) {
    throw new Error("count must be an integer from 1 to 4")
  }
  if (args.background === "transparent" && args.output_format === "jpeg") {
    throw new Error("transparent background requires PNG or WebP")
  }
  if (args.quality && !["auto", "low", "medium", "high", "xhigh", "max"].includes(args.quality)) {
    throw new Error("Unsupported quality")
  }
  if (args.background && !["auto", "opaque", "transparent"].includes(args.background)) {
    throw new Error("Unsupported background")
  }
  if (args.output_format && !["png", "jpeg", "webp"].includes(args.output_format)) {
    throw new Error("Unsupported output_format")
  }
  if (args.output_dir !== undefined && (typeof args.output_dir !== "string" || !args.output_dir.trim())) {
    throw new Error("output_dir must be a non-empty path")
  }
  if (args.size !== undefined && args.size !== "auto" && !/^\d+x\d+$/.test(args.size)) {
    throw new Error("size must be auto or WIDTHxHEIGHT")
  }
  if ((args.quality === "xhigh" || args.quality === "max") &&
      !/^gpt-image-2\.5-(sunburst|flare)(-2026-09-08)?$/.test(modelName(args.model))) {
    throw new Error("xhigh and max quality are only available on GPT Image 2.5 models")
  }
  if (args.images !== undefined && (!Array.isArray(args.images) || !args.images.length || args.images.length > 16 ||
      args.images.some((image) => typeof image !== "string" || !image.trim()))) {
    throw new Error("images must contain 1 to 16 non-empty references")
  }
  if (args.mask !== undefined && (!args.images?.length || typeof args.mask !== "string" || !args.mask.trim())) {
    throw new Error("mask requires at least one reference image")
  }
  if (args.async_mode !== undefined && typeof args.async_mode !== "boolean") throw new Error("async_mode must be a boolean")
  if (args.timeout_seconds !== undefined &&
      (!Number.isInteger(args.timeout_seconds) || args.timeout_seconds < 1 || args.timeout_seconds > 1800)) {
    throw new Error("timeout_seconds must be an integer from 1 to 1800")
  }
  if (args.timeout_seconds !== undefined && !args.async_mode) {
    throw new Error("timeout_seconds is only used with async_mode")
  }
}

async function checkedJson<T>(res: Response, asyncSubmit = false): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    let message = ""
    try {
      const error = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message
      if (typeof error === "string") message = error.slice(0, 300)
    } catch { /* Avoid dumping upstream HTML or credentials into errors. */ }
    if (res.status === 404 && asyncSubmit) {
      throw new Error("Sub2API async image tasks are unavailable (404). Enable image object storage and use an OpenAI-capable group.")
    }
    throw new Error(`Image request failed (${res.status})${message ? `: ${message}` : ""}`)
  }
  return (await res.json()) as T
}

function requireImages(json: ImageResponse | undefined): ImageResponse {
  if (!Array.isArray(json?.data) || !json.data.length) throw new Error("Image endpoint returned no images")
  return json
}

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

async function imageReference(value: string, directory: string, mask = false): Promise<string> {
  if (/^https?:\/\//i.test(value) && !mask) return value
  if (mask && /^https?:\/\//i.test(value)) throw new Error("mask must be a local PNG or PNG data URL")
  let bytes: Buffer
  if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(value)) {
    bytes = Buffer.from(value.slice(value.indexOf(",") + 1), "base64")
  } else if (/^data:/i.test(value) || (/^\w+:\/\//.test(value) && !value.startsWith("file://"))) {
    throw new Error("Reference images must be local files, PNG/JPEG/WebP data URLs, or HTTP URLs (mask: local PNG or data URL)")
  } else {
    const path = value.startsWith("file://") ? fileURLToPath(value) : isAbsolute(value) ? value : resolve(directory, value)
    bytes = await readFile(path)
  }
  if (bytes.length > MAX_REFERENCE_BYTES) throw new Error("Reference image exceeds the 20 MiB upload limit")
  const { mime } = imageType(bytes)
  if (mask && mime !== "image/png") throw new Error("mask must be a PNG image")
  return `data:${mime};base64,${bytes.toString("base64")}`
}

async function imageInputs(args: ImageArgs, directory: string) {
  const images = args.images?.length ? await Promise.all(args.images.map((image) => imageReference(image, directory))) : undefined
  const mask = args.mask ? await imageReference(args.mask, directory, true) : undefined
  return { images, mask }
}

function retryDelay(res: Response): number {
  const header = res.headers.get("Retry-After")
  if (header === null) return 3000
  const value = Number(header)
  return Number.isFinite(value) && value >= 0 ? Math.max(250, Math.min(30_000, value * 1000)) : 3000
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Image request cancelled"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("Image request cancelled"))
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function taskId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Sub2API image task ID")
  return value
}

async function pollTask(id: string, options: ResolvedOptions, transport: ImageTransport, signal?: AbortSignal,
  progress?: (status: string) => void | Promise<void>, initialDelay = 3000): Promise<ImageResponse> {
  const pollURL = imageEndpoint(options.baseURL, `/images/tasks/${encodeURIComponent(taskId(id))}`)
  let delay = initialDelay
  while (true) {
    if (delay) await pause(delay, signal)
    const polled = await transport.request(pollURL, { headers: { Authorization: `Bearer ${options.apiKey}` }, signal })
    const task = await checkedJson<TaskResponse>(polled)
    if (task.task_id && task.task_id !== id) throw new Error("Sub2API returned a mismatched task ID")
    if (task.status === "completed") return requireImages(task.result)
    if (task.status !== "processing" && task.status !== "queued") {
      throw new Error(`Sub2API image task ${id} ${task.status ?? "returned an unknown status"}${task.error?.message ? `: ${task.error.message.slice(0, 300)}` : ""}`)
    }
    await progress?.(`Sub2API image task ${id}: ${task.status}`)
    delay = retryDelay(polled)
  }
}

async function callAPI(args: ImageArgs, directory: string, options: ResolvedOptions, transport: ImageTransport, signal?: AbortSignal,
  progress?: (status: string) => void | Promise<void>): Promise<ImageResponse> {
  const { images, mask } = await imageInputs(args, directory)
  const endpoint = images ? "/images/edits" : "/images/generations"
  const body = {
    model: modelName(args.model),
    prompt: args.prompt,
    ...(args.count !== undefined ? { n: args.count } : {}),
    ...(args.size ? { size: args.size } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
    ...(args.background ? { background: args.background } : {}),
    ...(args.output_format ? { output_format: args.output_format } : {}),
    ...(images ? { images: images.map((image_url) => ({ image_url })) } : {}),
    ...(mask ? { mask: { image_url: mask } } : {}),
  }
  const url = imageEndpoint(options.baseURL, `${endpoint}${args.async_mode ? "/async" : ""}`)
  const controller = args.async_mode ? new AbortController() : undefined
  const abort = () => controller?.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timer = controller ? setTimeout(() => controller.abort(new Error("Image task polling timed out")),
    (args.timeout_seconds ?? 1800) * 1000) : undefined
  const activeSignal = controller?.signal ?? signal
  let taskID: string | undefined
  try {
    const res = await transport.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: activeSignal,
    })
    if (!args.async_mode) return requireImages(await checkedJson<ImageResponse>(res))
    if (res.status !== 202) {
      await checkedJson(res, true)
      throw new Error(`Expected Sub2API task acceptance (202), got ${res.status}`)
    }
    const submission = await checkedJson<TaskResponse>(res)
    const id = taskId(submission.task_id ?? submission.id ?? "")
    taskID = id
    await progress?.(`Sub2API image task ${id}: ${submission.status ?? "submitted"}`)
    return await pollTask(id, options, transport, activeSignal, progress, retryDelay(res))
  } catch (error) {
    if (controller?.signal.aborted && !signal?.aborted) {
      throw new Error(`Sub2API image task${taskID ? ` ${taskID}` : ""} timed out. It may still complete remotely; do not submit the request again blindly.`, { cause: error })
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

async function callCodex(args: ImageArgs, directory: string, loadAuth: AuthLoader | undefined, signal?: AbortSignal): Promise<ImageResponse> {
  if (modelName(args.model) !== "gpt-image-2") throw new Error("Codex backend only supports gpt-image-2")
  if ((args.count ?? 1) !== 1 || (args.quality && args.quality !== "auto") ||
      (args.output_format && args.output_format !== "png")) {
    throw new Error("Codex backend supports one PNG per call; quality is selected by the backend")
  }
  if (args.async_mode || args.mask) throw new Error("Codex backend does not support Sub2API async tasks or image masks")
  if (args.images && args.images.length > 5) throw new Error("Codex backend supports at most 5 reference images")
  const auth = await loadAuth?.()
  if (!auth?.access) throw new Error("No active ChatGPT Codex OAuth connection")
  const sizeHint = args.size && args.size !== "auto" ? ` Generate the image with a width of ${args.size.split("x")[0]} pixels and a height of ${args.size.split("x")[1]} pixels.` : ""
  const { images } = await imageInputs(args, directory)
  const endpoint = images ? "edits" : "generations"
  return requireImages(await checkedJson<ImageResponse>(await fetch(`https://chatgpt.com/backend-api/codex/images/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      originator: "opencode",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: args.prompt + sizeHint,
      background: args.background ?? "opaque",
      quality: "auto",
      size: "auto",
      ...(images ? { images: images.map((image_url) => ({ image_url })) } : {}),
    }),
    signal,
  })))
}

async function outputDirectory(outputDir: string | undefined, directory: string): Promise<string> {
  const target = outputDir ? (isAbsolute(outputDir) ? outputDir : resolve(directory, outputDir)) : join(directory, ".gpt-tmp")
  await mkdir(target, { recursive: true })
  if (!outputDir) {
    try {
      const file = await open(join(target, ".gitignore"), "wx")
      try { await file.writeFile("*\n") } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  return target
}

export async function generateImage(
  args: ImageArgs,
  directory: string,
  options: Options = {},
  signal?: AbortSignal,
  loadAuth?: AuthLoader,
  progress?: (status: string) => void | Promise<void>,
): Promise<GeneratedImage[]> {
  const config = resolveOptions(options)
  const asyncMode = args.async_mode ?? (config.asyncMode === "sub2api")
  const effective: ImageArgs = {
    ...args,
    model: args.model ?? config.defaultModel,
    async_mode: asyncMode,
    timeout_seconds: args.timeout_seconds ?? (asyncMode ? config.taskTimeoutSeconds : undefined),
  }
  validate(effective)
  const transport = await createTransport(config.backend === "api" && config.insecureTLS)
  try {
    const json = config.backend === "codex" ? await callCodex(effective, directory, loadAuth, signal) :
      await callAPI(effective, directory, config, transport, signal, progress)
    return await saveImages(json, effective.output_dir, directory, transport, signal)
  } finally {
    await transport.close()
  }
}

async function saveImages(json: ImageResponse, outputDir: string | undefined, directory: string,
  transport: ImageTransport, signal?: AbortSignal): Promise<GeneratedImage[]> {
  const target = await outputDirectory(outputDir, directory)
  const decoded: { bytes: Buffer; mime: string; ext: string }[] = []
  for (const [index, item] of json.data!.entries()) {
    let bytes: Buffer
    if (typeof item.b64_json === "string" || typeof item.b64 === "string") {
      const value = (item.b64_json ?? item.b64)!.replace(/^data:[^;]+;base64,/, "")
      bytes = Buffer.from(value, "base64")
    } else if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
      const res = await transport.request(item.url, { signal })
      if (!res.ok) throw new Error(`Image download failed (${res.status})`)
      bytes = Buffer.from(await res.arrayBuffer())
    } else {
      throw new Error(`Image item ${index + 1} has neither base64 data nor an HTTP URL`)
    }
    const type = imageType(bytes)
    decoded.push({ bytes, ...type })
  }
  const saved: GeneratedImage[] = []
  for (const { bytes, mime, ext } of decoded) {
    const file = join(target, `gpt-image-${Date.now()}-${randomUUID()}${ext}`)
    await writeFile(file, bytes, { flag: "wx" })
    saved.push({ path: file, mime, uri: pathToFileURL(file).href })
  }
  return saved
}

export async function resumeImageTask(id: string, directory: string, options: Options = {},
  outputDir?: string, timeoutSeconds?: number, signal?: AbortSignal,
  progress?: (status: string) => void | Promise<void>): Promise<GeneratedImage[]> {
  taskId(id)
  const config = resolveOptions(options)
  timeoutSeconds ??= config.taskTimeoutSeconds
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) {
    throw new Error("timeout_seconds must be an integer from 1 to 1800")
  }
  if (config.backend !== "api") throw new Error("Sub2API image tasks require the API backend")
  const transport = await createTransport(config.insecureTLS)
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Image task polling timed out")), timeoutSeconds * 1000)
  try {
    const json = await pollTask(id, config, transport, controller.signal, progress, 0)
    return await saveImages(json, outputDir, directory, transport, controller.signal)
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`Sub2API image task ${id} timed out. It may still complete remotely; retry polling this task ID instead of submitting a new request.`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    await transport.close()
  }
}

export function v1Attachments(images: GeneratedImage[]) {
  return images.map(({ path, mime, uri }) => ({ type: "file" as const, mime, url: uri, filename: basename(path) }))
}
