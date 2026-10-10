import type { Dispatcher } from "undici"

export interface ImageTransport {
  request(url: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

export async function createTransport(insecureTLS: boolean): Promise<ImageTransport> {
  if (!insecureTLS) {
    return { request: (url, init) => fetch(url, init), close: async () => {} }
  }
  if ("Bun" in globalThis) {
    return {
      request: (url, init) => fetch(url, { ...init, tls: { rejectUnauthorized: false } } as RequestInit),
      close: async () => {},
    }
  }
  const { Agent } = await import("undici")
  const dispatcher: Dispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  return {
    request: (url, init) => fetch(url, { ...init, dispatcher } as RequestInit),
    close: () => dispatcher.close(),
  }
}
