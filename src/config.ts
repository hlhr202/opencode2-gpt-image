import { DEFAULT_IMAGE_MODEL, modelName, type ImageModel } from "./models.js"

export interface Options {
  baseURL?: string
  apiKey?: string
  backend?: "api" | "codex"
  insecureTLS?: boolean
  defaultModel?: ImageModel
  asyncMode?: "sync" | "sub2api"
  taskTimeoutSeconds?: number
}

export type ResolvedOptions = Required<Options>

function optionalBoolean(value: string | undefined): boolean {
  if (value === undefined) return false
  if (/^(1|true)$/i.test(value)) return true
  if (/^(0|false)$/i.test(value)) return false
  throw new Error("GPT_IMAGE_INSECURE_TLS must be true, false, 1, or 0")
}

export function resolveOptions(options: Options = {}): ResolvedOptions {
  const backend = options.backend ?? (process.env.GPT_IMAGE_BACKEND as Options["backend"]) ?? "api"
  if (backend !== "api" && backend !== "codex") throw new Error("backend must be api or codex")
  const baseURL = options.baseURL ?? (process.env.GPT_IMAGE_BASE_URL || process.env.CPA_BASE_URL || "")
  const apiKey = options.apiKey ?? (process.env.GPT_IMAGE_API_KEY || process.env.CPA_API_KEY || "")
  const insecureTLS = options.insecureTLS ?? optionalBoolean(process.env.GPT_IMAGE_INSECURE_TLS)
  if (typeof insecureTLS !== "boolean") throw new Error("insecureTLS must be a boolean")
  const defaultModel = modelName(options.defaultModel ?? process.env.GPT_IMAGE_DEFAULT_MODEL ?? DEFAULT_IMAGE_MODEL)
  const asyncMode = options.asyncMode ?? process.env.GPT_IMAGE_ASYNC_MODE ?? "sync"
  if (asyncMode !== "sync" && asyncMode !== "sub2api") throw new Error("asyncMode must be sync or sub2api")
  const taskTimeoutSeconds = options.taskTimeoutSeconds ??
    (process.env.GPT_IMAGE_TASK_TIMEOUT_SECONDS === undefined ? 1800 : Number(process.env.GPT_IMAGE_TASK_TIMEOUT_SECONDS))
  if (!Number.isInteger(taskTimeoutSeconds) || taskTimeoutSeconds < 1 || taskTimeoutSeconds > 1800) {
    throw new Error("taskTimeoutSeconds must be an integer from 1 to 1800")
  }
  if (backend === "api" && (!baseURL || !apiKey)) {
    throw new Error("GPT Image requires baseURL and apiKey (or GPT_IMAGE_BASE_URL and GPT_IMAGE_API_KEY)")
  }
  if (baseURL) {
    const url = new URL(baseURL)
    if (!["https:", "http:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      throw new Error("baseURL must be an http(s) URL without credentials, query, or fragment")
    }
  }
  return { backend, baseURL, apiKey, insecureTLS, defaultModel, asyncMode, taskTimeoutSeconds }
}

export function imageEndpoint(baseURL: string, suffix: string): string {
  const root = baseURL.replace(/\/+$/, "")
  return `${/\/v1$/i.test(root) ? root : `${root}/v1`}${suffix}`
}
