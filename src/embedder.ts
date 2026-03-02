/**
 * Lazy-loaded local embedding function using @huggingface/transformers.
 * Downloads the model on first use and caches it locally.
 *
 * Default: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~22M params)
 * With quantized=true (default), uses the q8 (8-bit) ONNX variant.
 *
 * Verbatim from memelord's packages/cli/src/embedder.ts.
 */
import type { EmbedFn } from 'memelord'

let cachedEmbedder: EmbedFn | null = null

export async function createEmbedder(): Promise<EmbedFn> {
  if (cachedEmbedder) return cachedEmbedder

  process.env.TRANSFORMERS_VERBOSITY ??= 'error'

  const { pipeline } = await import('@huggingface/transformers')

  const model = process.env.MEMELORD_MODEL ?? 'Xenova/all-MiniLM-L6-v2'

  const extractor = await pipeline('feature-extraction', model, {
    quantized: true,
    dtype: 'q8',
  } as any)

  cachedEmbedder = async (text: string): Promise<Float32Array> => {
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    return new Float32Array(output.data as Float64Array)
  }

  return cachedEmbedder
}
