import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { IntegrationDomain } from "@opencode/plugin/promise/integration"
import type { CodexAuth } from "./image.js"

// V1 has no public credential service for plugins. Never use this file in V2.
export async function v1CodexAuth(): Promise<CodexAuth | undefined> {
  try {
    const raw = process.env.OPENCODE_AUTH_CONTENT ?? await readFile(
      join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json"),
      "utf8",
    )
    const entry = (JSON.parse(raw) as { openai?: { type?: string; access?: string; accountId?: string } }).openai
    if (entry?.type !== "oauth" || !entry.access) return undefined
    return { access: entry.access, accountId: entry.accountId }
  } catch { return undefined }
}

export async function v2CodexAuth(
  connection: Pick<IntegrationDomain["connection"], "active" | "resolve">,
): Promise<CodexAuth | undefined> {
  const active = await connection.active("openai")
  if (!active) return undefined
  const credential = await connection.resolve(active) as {
    type?: string; access?: string; methodID?: string; metadata?: { accountID?: string }
  } | undefined
  if (credential?.type !== "oauth" || !credential.access) return undefined
  if (credential.methodID === "chatgpt-token-sharing") {
    throw new Error("Codex image generation requires a direct ChatGPT Codex OAuth connection, not token sharing")
  }
  if (credential.methodID !== "chatgpt-browser" && credential.methodID !== "chatgpt-headless") return undefined
  return { access: credential.access, accountId: credential.metadata?.accountID }
}
