// Public IDs from the OpenAI Images API. Proxy-specific aliases are intentionally excluded.
// https://developers.openai.com/api/reference/resources/images/methods/generate
export const IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2-2026-04-21",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-flare-2026-09-08",
  "chatgpt-image-latest",
] as const

export type ImageModel = (typeof IMAGE_MODELS)[number]
export const DEFAULT_IMAGE_MODEL: ImageModel = "gpt-image-2"

export function modelName(value: unknown): ImageModel {
  const model = value === undefined ? DEFAULT_IMAGE_MODEL : value
  if (typeof model !== "string" || !IMAGE_MODELS.some((candidate) => candidate === model)) {
    throw new Error(`Unsupported model: ${String(model)}. Use an OpenAI Images API model ID.`)
  }
  return model as ImageModel
}
