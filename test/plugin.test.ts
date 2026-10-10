import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { v1CodexAuth, v2CodexAuth } from "../src/auth.js"
import { imageEndpoint, resolveOptions } from "../src/config.js"
import { generateImage, resumeImageTask } from "../src/image.js"
import GptImagePlugin, { v2TaskTool, v2Tool } from "../src/index.js"
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, modelName } from "../src/models.js"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VZ91xkAAAAASUVORK5CYII=", "base64")

test("only official OpenAI image model names are accepted", () => {
  assert.equal(DEFAULT_IMAGE_MODEL, "gpt-image-2")
  assert.ok(IMAGE_MODELS.includes("gpt-image-2.5-sunburst"))
  assert.ok(IMAGE_MODELS.includes("gpt-image-2.5-flare"))
  assert.equal(modelName(undefined), DEFAULT_IMAGE_MODEL)
  assert.throws(() => modelName("gpt-image-2.5"), /Unsupported model/)
  assert.throws(() => modelName("openai\/gpt-image-2"), /Unsupported model/)
})

test("proxy options use explicit values before environment, normalize v1 once", () => {
  assert.equal(imageEndpoint("https://proxy.test/v1/", "/images/generations"), "https://proxy.test/v1/images/generations")
  assert.equal(imageEndpoint("https://proxy.test/api", "/images/generations"), "https://proxy.test/api/v1/images/generations")
  assert.deepEqual(resolveOptions({ baseURL: "https://proxy.test", apiKey: "key" }).backend, "api")
  assert.throws(() => resolveOptions({ baseURL: "file:///etc/passwd", apiKey: "key" }), /http\(s\)/)
})

test("plugin options override environment and validate all new defaults", () => {
  const names = ["GPT_IMAGE_BASE_URL", "GPT_IMAGE_API_KEY", "GPT_IMAGE_INSECURE_TLS", "GPT_IMAGE_DEFAULT_MODEL",
    "GPT_IMAGE_ASYNC_MODE", "GPT_IMAGE_TASK_TIMEOUT_SECONDS"] as const
  const previous = names.map((name) => process.env[name])
  try {
    process.env.GPT_IMAGE_BASE_URL = "https://env.test"
    process.env.GPT_IMAGE_API_KEY = "env-key"
    process.env.GPT_IMAGE_INSECURE_TLS = "true"
    process.env.GPT_IMAGE_DEFAULT_MODEL = "gpt-image-1"
    process.env.GPT_IMAGE_ASYNC_MODE = "sub2api"
    process.env.GPT_IMAGE_TASK_TIMEOUT_SECONDS = "99"
    assert.deepEqual(resolveOptions({ baseURL: "https://option.test", apiKey: "option-key", insecureTLS: false,
      defaultModel: "gpt-image-2", asyncMode: "sync", taskTimeoutSeconds: 4 }), {
      backend: "api", baseURL: "https://option.test", apiKey: "option-key", insecureTLS: false,
      defaultModel: "gpt-image-2", asyncMode: "sync", taskTimeoutSeconds: 4,
    })
    assert.equal(resolveOptions().insecureTLS, true)
    assert.equal(resolveOptions().taskTimeoutSeconds, 99)
    assert.throws(() => resolveOptions({ baseURL: "", apiKey: "option-key" }), /requires baseURL and apiKey/)
    assert.throws(() => resolveOptions({ insecureTLS: "yes" as never }), /insecureTLS must be a boolean/)
    assert.throws(() => resolveOptions({ defaultModel: "proxy-alias" as never }), /Unsupported model/)
    assert.throws(() => resolveOptions({ asyncMode: "auto" as never }), /asyncMode/)
    assert.throws(() => resolveOptions({ taskTimeoutSeconds: 0 }), /taskTimeoutSeconds/)
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
})

test("plugin defaults apply in V1/V2 without per-call async overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-defaults-"))
  const original = globalThis.fetch
  const calls: { url: string; body?: { model: string } }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (url.endsWith("/async")) {
      return new Response(JSON.stringify({ task_id: "imgtask_defaults", status: "queued" }),
        { status: 202, headers: { "Retry-After": "0" } })
    }
    if (url.includes("/tasks/")) return new Response(JSON.stringify({ task_id: "imgtask_defaults", status: "completed",
      result: { data: [{ b64_json: PNG.toString("base64") }] } }))
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
  }
  try {
    const options = { baseURL: "https://proxy.test", apiKey: "key", defaultModel: "gpt-image-1" as const,
      asyncMode: "sub2api" as const, taskTimeoutSeconds: 2 }
    const tool = v2Tool(options, async () => dir, async () => undefined)
    const statuses: string[] = []
    const ctx = { sessionID: "s", signal: new AbortController().signal,
      progress: async ({ status }: { status: string }) => { statuses.push(status) } } as unknown as ToolContext
    const result = await tool.execute({ prompt: "bird" }, ctx)
    assert.equal(result.metadata?.model, "gpt-image-1")
    assert.equal(result.metadata?.execution_mode, "sub2api")
    assert.equal(result.metadata?.task_id, "imgtask_defaults")
    assert.ok(Array.isArray(result.content))
    assert.match((result.content[0] as { text: string }).text, /Sub2API async task imgtask_defaults completed/)
    assert.match(tool.description, /Configured for Sub2API asynchronous submission/)
    assert.equal("async_mode" in (tool.input as { properties: Record<string, unknown> }).properties, false)
    assert.equal("timeout_seconds" in (tool.input as { properties: Record<string, unknown> }).properties, false)
    assert.equal(calls[0].url, "https://proxy.test/v1/images/generations/async")
    assert.equal(calls[0].body?.model, "gpt-image-1")
    assert.equal(calls[1].url, "https://proxy.test/v1/images/tasks/imgtask_defaults")
    assert.equal(statuses[0], "Submitting Sub2API async image task")
    assert.match(statuses[1], /imgtask_defaults: queued/)
    assert.ok(statuses.every((status) => !status.includes("undefined")))

    const v1 = await GptImagePlugin.server({ directory: dir }, options)
    const v1Tool = v1.tool.gpt_image as { args: Record<string, unknown>; description: string;
      execute(args: unknown, ctx: unknown): Promise<{ metadata: { model: string; execution_mode: string; task_id: string } }> }
    assert.equal("async_mode" in v1Tool.args, false)
    assert.equal("timeout_seconds" in v1Tool.args, false)
    assert.match(v1Tool.description, /Configured for Sub2API asynchronous submission/)
    const override = await v1Tool.execute({ prompt: "bird", model: "gpt-image-2" },
      { directory: dir, abort: ctx.signal, metadata: () => {} })
    assert.equal(override.metadata.model, "gpt-image-2")
    assert.equal(override.metadata.execution_mode, "sub2api")
    assert.equal(override.metadata.task_id, "imgtask_defaults")
    assert.equal(calls[2].url, "https://proxy.test/v1/images/generations/async")
    assert.equal(calls[2].body?.model, "gpt-image-2")

    await assert.rejects(generateImage({ prompt: "bird", async_mode: false } as never, dir, options), /plugin configuration/)
    const task = await v2TaskTool(options, async () => dir).execute({ task_id: "imgtask_defaults" }, ctx)
    assert.ok(Array.isArray(task.content))
    assert.equal(task.metadata?.task_id, "imgtask_defaults")
    assert.equal(calls[4].url, "https://proxy.test/v1/images/tasks/imgtask_defaults")
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("insecureTLS switches certificate validation for real API requests without changing global TLS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-tls-"))
  let server: ReturnType<typeof createServer> | undefined
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"),
      "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" })
    const requests: string[] = []
    server = createServer({ key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) },
      (req, res) => {
        requests.push(req.url ?? "")
        if (req.url?.endsWith("/async")) {
          res.writeHead(202, { "Content-Type": "application/json", "Retry-After": "0" })
          res.end(JSON.stringify({ task_id: "imgtask_tls", status: "queued" }))
        } else if (req.url?.includes("/tasks/")) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ task_id: "imgtask_tls", status: "completed", result: { data: [{ url: `https://localhost:${(server!.address() as { port: number }).port}/image.png` }] } }))
        } else if (req.url === "/image.png") {
          res.setHeader("Content-Type", "image/png")
          res.end(PNG)
        } else {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
        }
      })
    await new Promise<void>((resolve, reject) => server!.once("error", reject).listen(0, "localhost", resolve))
    const baseURL = `https://localhost:${(server.address() as { port: number }).port}`
    await assert.rejects(generateImage({ prompt: "bird" }, dir, { baseURL, apiKey: "key", insecureTLS: false }),
      /fetch failed|certificate|self.signed/i)
    assert.equal(requests.length, 0)
    const files = await generateImage({ prompt: "bird" }, dir,
      { baseURL, apiKey: "key", insecureTLS: true, asyncMode: "sub2api" })
    assert.deepEqual(requests, ["/v1/images/generations/async", "/v1/images/tasks/imgtask_tls", "/image.png"])
    assert.deepEqual(await readFile(files[0].path), PNG)
    const resumed = await resumeImageTask("imgtask_tls", dir, { baseURL, apiKey: "key", insecureTLS: true })
    assert.deepEqual(await readFile(resumed[0].path), PNG)
    assert.deepEqual(requests.slice(-2), ["/v1/images/tasks/imgtask_tls", "/image.png"])
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, previous)
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test("V1 and V2 register the same generation and task tools", async () => {
  assert.equal(GptImagePlugin.id, "gpt-image")
  const tools: Info[] = []
  await GptImagePlugin.setup({
    options: {},
    tool: { transform: async (callback: (editor: { add(tool: Info): void }) => void) => callback({ add: (tool) => tools.push(tool) }) },
    session: { get: async () => ({ location: { directory: "/session" } }) },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
  } as unknown as Plugin.Context)
  assert.deepEqual(tools.map((tool) => tool.name), ["gpt_image", "gpt_image_task"])
  assert.deepEqual((tools[0].input as { required: string[] }).required, ["prompt"])
  const v1 = await GptImagePlugin.server({ directory: "/project" })
  assert.deepEqual(Object.keys(v1.tool), ["gpt_image", "gpt_image_task"])
  const tool = v1.tool.gpt_image as { args: Record<string, unknown>; description: string }
  assert.deepEqual(Object.keys(tool.args).sort(), Object.keys((tools[0].input as { properties: Record<string, unknown> }).properties).sort())
  const task = v1.tool.gpt_image_task as { args: Record<string, unknown> }
  assert.deepEqual(Object.keys(task.args).sort(), Object.keys((tools[1].input as { properties: Record<string, unknown> }).properties).sort())
  assert.match(tools[0].description, /Configured for synchronous image requests/)
  assert.match(tool.description as string, /Configured for synchronous image requests/)
  assert.equal("async_mode" in tool.args, false)
  assert.equal("timeout_seconds" in tool.args, false)
})

test("Codex tool descriptions and schemas reflect its configured backend", async () => {
  const options = { backend: "codex" as const }
  const v2 = v2Tool(options, async () => "/session", async () => undefined)
  const v1 = await GptImagePlugin.server({ directory: "/session" }, options)
  const properties = (v2.input as { properties: Record<string, { enum?: string[]; maxItems?: number }> }).properties
  const v1Args = (v1.tool.gpt_image as { args: Record<string, { safeParse(value: unknown): { success: boolean } }> }).args
  assert.match(v2.description, /transparent\/opaque/)
  assert.match((v1.tool.gpt_image as { description: string }).description, /transparent\/opaque/)
  assert.deepEqual(properties.model.enum, ["gpt-image-2"])
  assert.deepEqual(properties.quality.enum, ["auto", "low", "medium", "high"])
  assert.deepEqual(properties.output_format.enum, ["png"])
  assert.equal(properties.images.maxItems, 5)
  assert.equal("mask" in properties, false)
  assert.equal("mask" in v1Args, false)
  assert.equal("async_mode" in properties, false)
  assert.equal(v1Args.output_format.safeParse("webp").success, false)
  assert.equal(v1Args.quality.safeParse("high").success, true)
  assert.equal(v1Args.model.safeParse("gpt-image-1").success, false)
  assert.deepEqual(Object.keys(v1.tool), ["gpt_image"])
  const registered: Info[] = []
  await GptImagePlugin.setup({
    options,
    tool: { transform: async (callback: (editor: { add(tool: Info): void }) => void) =>
      callback({ add: (item) => registered.push(item) }) },
    session: { get: async () => ({ location: { directory: "/session" } }) },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
  } as unknown as Plugin.Context)
  assert.deepEqual(registered.map((item) => item.name), ["gpt_image"])
  assert.throws(() => v2Tool({ backend: "codex", asyncMode: "sub2api" }, async () => "/", async () => undefined), /require backend: api/)
  assert.throws(() => resolveOptions({ backend: "codex", defaultModel: "gpt-image-1" }), /requires defaultModel: gpt-image-2/)
})

test("both versions use session directory, cancellation, and actual PNG file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt image-"))
  const original = globalThis.fetch
  const calls: { url: string; body: Record<string, unknown>; signal?: AbortSignal }[] = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal as AbortSignal })
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
  }
  try {
    const options = { baseURL: "https://proxy.test/v1", apiKey: "test" }
    const controller = new AbortController()
    const v2 = v2Tool(options, async () => dir, async () => undefined)
    const result = await v2.execute({ prompt: "a crane", output_dir: "assets/img" }, {
      sessionID: "session-1", signal: controller.signal, progress: async () => {},
    } as unknown as ToolContext)
    assert.equal(result.metadata?.execution_mode, "sync")
    assert.equal(result.metadata?.backend, "api")
    assert.equal(calls[0].url, "https://proxy.test/v1/images/generations")
    assert.equal(calls[0].body.model, "gpt-image-2")
    assert.equal(calls[0].signal, controller.signal)
    assert.ok(Array.isArray(result.content))
    const file = result.content[1]
    assert.equal(file.type, "file")
    if (file.type !== "file") throw new Error("expected image file")
    assert.equal(file.mime, "image/png")
    assert.ok(file.uri.includes("gpt%20image-"))
    assert.ok(fileURLToPath(file.uri).startsWith(join(dir, "assets/img")))
    assert.deepEqual(await readFile(fileURLToPath(file.uri)), PNG)

    const v1 = await GptImagePlugin.server({ directory: "/wrong" }, options)
    const v1Tool = v1.tool.gpt_image as { execute(args: unknown, ctx: unknown): Promise<{ attachments: { url: string }[] }> }
    const first = await v1Tool.execute({ prompt: "a crane", output_dir: "assets/img" }, { directory: dir, abort: controller.signal })
    assert.equal(calls[1].signal, controller.signal)
    assert.notEqual(first.attachments[0].url, file.uri)
    assert.deepEqual(await readFile(fileURLToPath(first.attachments[0].url)), PNG)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("proxy errors and invalid parameters do not create output", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "not available" } }), { status: 403 })
  try {
    const config = { baseURL: "https://proxy.test", apiKey: "test" }
    await assert.rejects(generateImage({ prompt: "hi" }, tmpdir(), config), /403.*not available/)
    await assert.rejects(generateImage({ prompt: "hi", model: "gpt-image-2", quality: "max" }, tmpdir(), config), /2.5/)
    await assert.rejects(generateImage({ prompt: "hi", background: "transparent", output_format: "jpeg" }, tmpdir(), config), /PNG or WebP/)
    await assert.rejects(generateImage({ prompt: "hi", quality: "ultra" as never }, tmpdir(), config), /Unsupported quality/)
  } finally { globalThis.fetch = original }
})

test("proxy-compatible image URLs are downloaded and identified from bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-url-"))
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    requests.push(String(input))
    if (requests.length === 1) {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer proxy-key")
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "gpt-image-2.5-flare", prompt: "a crane", n: 2, quality: "max", output_format: "png",
      })
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.test/image" }] }))
    }
    return new Response(PNG)
  }
  try {
    const files = await generateImage({ prompt: "a crane", model: "gpt-image-2.5-flare", count: 2, quality: "max", output_format: "png" },
      dir, { baseURL: "https://proxy.test", apiKey: "proxy-key" })
    assert.deepEqual(requests, ["https://proxy.test/v1/images/generations", "https://cdn.test/image"])
    assert.equal(files[0].mime, "image/png")
    assert.deepEqual(await readFile(files[0].path), PNG)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("transparent requests disclose incompatible returned JPEG without resubmitting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-transparency-"))
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("ffd8ff0000", "hex").toString("base64") }] }))
  }
  try {
    const tool = v2Tool({ baseURL: "https://proxy.test", apiKey: "key" }, async () => dir, async () => undefined)
    const result = await tool.execute({ prompt: "transparent bird", background: "transparent" },
      { sessionID: "s", signal: new AbortController().signal, progress: async () => {} } as unknown as ToolContext)
    assert.equal(calls, 1)
    assert.ok(Array.isArray(result.content))
    assert.match((result.content[0] as { text: string }).text, /JPEG, which cannot contain transparency/)
    assert.equal((result.content[1] as { mime: string }).mime, "image/jpeg")
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("reference image edit uses JSON images and PNG mask on the edits endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-edit-"))
  const original = globalThis.fetch
  await writeFile(join(dir, "input.png"), PNG)
  await writeFile(join(dir, "mask.png"), PNG)
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    calls.push(String(input))
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json")
    const body = JSON.parse(String(init?.body))
    assert.equal(body.prompt, "change color")
    assert.equal(body.model, "gpt-image-2")
    assert.deepEqual(body.images, [
      { image_url: `data:image/png;base64,${PNG.toString("base64")}` },
      { image_url: "https://example.test/reference.png" },
    ])
    assert.deepEqual(body.mask, { image_url: `data:image/png;base64,${PNG.toString("base64")}` })
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
  }
  try {
    const files = await generateImage({ prompt: "change color", images: ["input.png", "https://example.test/reference.png"],
      mask: "mask.png" }, dir, { baseURL: "https://proxy.test", apiKey: "test" })
    assert.deepEqual(calls, ["https://proxy.test/v1/images/edits"])
    assert.deepEqual(await readFile(files[0].path), PNG)
    await assert.rejects(generateImage({ prompt: "hi", mask: "mask.png" }, dir, { baseURL: "https://proxy.test", apiKey: "test" }), /mask requires/)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("Sub2API async generations submit, poll with same key, and download stored image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-async-"))
  const original = globalThis.fetch
  const calls: string[] = []
  const statuses: string[] = []
  globalThis.fetch = async (input, init) => {
    calls.push(String(input))
    if (calls.length === 1) {
      assert.equal(init?.method, "POST")
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer key")
      assert.equal(JSON.parse(String(init?.body)).model, "gpt-image-2")
      return new Response(JSON.stringify({ task_id: "imgtask_123", status: "processing", poll_url: "/v1/images/tasks/imgtask_123" }),
        { status: 202, headers: { "Retry-After": "0" } })
    }
    if (calls.length === 2) {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer key")
      return new Response(JSON.stringify({ task_id: "imgtask_123", status: "processing" }),
        { headers: { "Retry-After": "0" } })
    }
    if (calls.length === 3) {
      return new Response(JSON.stringify({ task_id: "imgtask_123", status: "completed",
        result: { data: [{ url: "https://storage.test/image.png" }] } }))
    }
    return new Response(PNG)
  }
  try {
    const files = await generateImage({ prompt: "bird" }, dir,
      { baseURL: "https://proxy.test/v1", apiKey: "key", asyncMode: "sub2api", taskTimeoutSeconds: 3 },
      undefined, undefined, (status) => { statuses.push(status) })
    assert.deepEqual(calls, [
      "https://proxy.test/v1/images/generations/async",
      "https://proxy.test/v1/images/tasks/imgtask_123",
      "https://proxy.test/v1/images/tasks/imgtask_123",
      "https://storage.test/image.png",
    ])
    assert.equal(statuses.length, 2)
    assert.deepEqual(await readFile(files[0].path), PNG)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("Sub2API async edits and resume polling work in both plugin tool surfaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-async-edit-"))
  const original = globalThis.fetch
  await writeFile(join(dir, "input.png"), PNG)
  let submits = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/edits/async")) {
      submits++
      assert.deepEqual(JSON.parse(String(init?.body)).images,
        [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }])
      return new Response(JSON.stringify({ task_id: "imgtask_edit", status: "queued" }),
        { status: 202, headers: { "Retry-After": "0" } })
    }
    assert.equal(url, "https://proxy.test/v1/images/tasks/imgtask_edit")
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer key")
    return new Response(JSON.stringify({ task_id: "imgtask_edit", status: "completed",
      result: { data: [{ b64_json: PNG.toString("base64") }] } }))
  }
  try {
    const options = { baseURL: "https://proxy.test", apiKey: "key", asyncMode: "sub2api" as const }
    const generated = await generateImage({ prompt: "edit", images: ["input.png"] }, dir, options)
    assert.equal(generated.length, 1)
    const taskTool = v2TaskTool(options, async () => dir)
    const context = { sessionID: "session-1", signal: new AbortController().signal,
      progress: async () => {} } as unknown as ToolContext
    const result = await taskTool.execute({ task_id: "imgtask_edit" }, context)
    assert.ok(Array.isArray(result.content))
    assert.equal(result.content[1].type, "file")
    const v1 = await GptImagePlugin.server({ directory: dir }, options)
    const task = v1.tool.gpt_image_task as { execute(args: unknown, ctx: unknown): Promise<{ attachments: { url: string }[] }> }
    const v1Result = await task.execute({ task_id: "imgtask_edit" }, { directory: dir, abort: context.signal, metadata: () => {} })
    assert.equal(v1Result.attachments.length, 1)
    assert.notEqual(v1Result.attachments[0].url, generated[0].uri)
    assert.equal(submits, 1) // Resuming an existing task never submits a new paid request.
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("disabled async endpoint, task failure and invalid task IDs are explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-async-error-"))
  const original = globalThis.fetch
  const options = { baseURL: "https://proxy.test", apiKey: "key", asyncMode: "sub2api" as const }
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "disabled" } }), { status: 404 })
  try {
    await assert.rejects(generateImage({ prompt: "bird" }, dir, options), /Enable image object storage/)
    await assert.rejects(resumeImageTask("../evil", dir, options), /Invalid Sub2API image task ID/)
    globalThis.fetch = async () => new Response(JSON.stringify({ task_id: "imgtask_1", status: "failed",
      error: { message: "upstream rejected" } }))
    await assert.rejects(resumeImageTask("imgtask_1", dir, options), /failed: upstream rejected/)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("an accepted Sub2API task times out with its ID and is never submitted twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-async-timeout-"))
  const original = globalThis.fetch
  let submits = 0
  globalThis.fetch = async () => {
    submits++
    return new Response(JSON.stringify({ task_id: "imgtask_pending", status: "processing" }),
      { status: 202, headers: { "Retry-After": "3" } })
  }
  try {
    await assert.rejects(generateImage({ prompt: "bird" }, dir,
      { baseURL: "https://proxy.test", apiKey: "key", asyncMode: "sub2api", taskTimeoutSeconds: 1 }), /imgtask_pending timed out/)
    assert.equal(submits, 1)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("failed async polling and image saving preserve the accepted task ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-async-recovery-"))
  const original = globalThis.fetch
  let submissions = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("/generations/async")) {
      submissions++
      return new Response(JSON.stringify({ task_id: "imgtask_recover", status: "processing" }),
        { status: 202, headers: { "Retry-After": "0" } })
    }
    if (url.endsWith("/tasks/imgtask_recover")) {
      return new Response(JSON.stringify({ task_id: "imgtask_recover", status: "completed",
        result: { data: [{ url: "https://storage.test/missing.png" }] } }))
    }
    return new Response("unavailable", { status: 503 })
  }
  try {
    await assert.rejects(generateImage({ prompt: "bird" }, dir,
      { baseURL: "https://proxy.test", apiKey: "key", asyncMode: "sub2api" }), /imgtask_recover completed, but saving its images failed/)
    assert.equal(submissions, 1)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("experimental Codex route uses Images endpoint, not Responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-codex-"))
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/images/generations")
    assert.equal(new Headers(init?.headers).get("ChatGPT-Account-Id"), "account")
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "gpt-image-2", prompt: "a crane", background: "opaque", quality: "auto", size: "auto",
    })
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
  }
  try {
    const files = await generateImage({ prompt: "a crane" }, dir, { backend: "codex" }, undefined,
      async () => ({ access: "token", accountId: "account" }))
    assert.equal(files.length, 1)
    await assert.rejects(generateImage({ prompt: "hi", model: "gpt-image-1" }, dir, { backend: "codex" }), /only supports/)
    await assert.rejects(generateImage({ prompt: "hi" }, dir, { backend: "codex" }), /No active/)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("Codex forwards count, size, quality and transparency; reports actual values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-codex-options-"))
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(url, "https://chatgpt.com/backend-api/codex/images/generations")
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "gpt-image-2", prompt: "a crane", background: "transparent", quality: "high",
      size: "1024x1024", n: 2,
    })
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }],
      size: "1024x1536", quality: "medium", background: "transparent" }))
  }
  try {
    const tool = v2Tool({ backend: "codex" }, async () => dir, async () => ({ access: "token" }))
    const result = await tool.execute({ prompt: "a crane", size: "1024x1024", quality: "high",
      background: "transparent", count: 2 }, { sessionID: "s", signal: new AbortController().signal,
      progress: async () => {} } as unknown as ToolContext)
    assert.equal(calls, 1)
    assert.equal(result.metadata?.execution_mode, "sync")
    assert.equal(result.metadata?.backend, "codex")
    assert.deepEqual(result.metadata?.backend_reported, { size: "1024x1536", quality: "medium", background: "transparent" })
    assert.ok(Array.isArray(result.content))
    const text = (result.content[0] as { text: string }).text
    assert.match(text, /Requested 2 image\(s\), but the backend returned 1/)
    assert.match(text, /Requested size 1024x1024, but the backend reported 1024x1536/)
    assert.match(text, /Requested quality high, but the backend reported medium/)
    assert.equal((result.content[1] as { mime: string }).mime, "image/png")
    await assert.rejects(generateImage({ prompt: "a crane", mask: "mask.png", images: ["image.png"] }, dir,
      { backend: "codex" }), /does not support image masks/)
    await assert.rejects(generateImage({ prompt: "a crane", output_format: "webp" }, dir,
      { backend: "codex" }), /cannot guarantee JPEG or WebP/)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("experimental Codex edit sends reference images to its edits endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gpt-codex-edit-"))
  const original = globalThis.fetch
  await writeFile(join(dir, "reference.png"), PNG)
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/images/edits")
    assert.deepEqual(JSON.parse(String(init?.body)).images,
      [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }])
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
  }
  try {
    const files = await generateImage({ prompt: "edit", images: ["reference.png"] }, dir, { backend: "codex" },
      undefined, async () => ({ access: "token" }))
    assert.equal(files.length, 1)
    await assert.rejects(generateImage({ prompt: "edit", images: ["reference.png"] },
      dir, { backend: "codex", asyncMode: "sub2api" }, undefined, async () => ({ access: "token" })), /require backend: api/)
  } finally {
    globalThis.fetch = original
    await rm(dir, { recursive: true, force: true })
  }
})

test("V1 reads its auth only; V2 resolves the selected integration", async () => {
  const prior = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "v1-token", accountId: "v1-account" } })
  try { assert.deepEqual(await v1CodexAuth(), { access: "v1-token", accountId: "v1-account" }) }
  finally {
    if (prior === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = prior
  }
  const connection = {
    active: async () => ({ id: "active" }),
    resolve: async () => ({ type: "oauth", methodID: "chatgpt-browser", access: "v2-token", metadata: { accountID: "v2-account" } }),
  }
  assert.deepEqual(await v2CodexAuth(connection as never), { access: "v2-token", accountId: "v2-account" })
})
