import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { fnv1a32 } from '@kody-internal/shared/fnv1a.ts'

/**
 * Workers AI embedding and Vectorize index access for every corpus that shares
 * the `CAPABILITY_VECTOR_INDEX` binding (builtin capabilities, saved packages,
 * memories, jobs). Lives outside `#mcp/*` because non-MCP subsystems — the
 * package registry, community search, job reindexing — embed and query the same
 * index, and used to reach into `#mcp/capabilities/capability-search.ts` to do
 * it.
 *
 * The `CAPABILITY_` name prefix refers to that shared binding, not to builtin
 * capabilities specifically.
 */

type VectorizeRuntimeEnv = {
	AI?: Ai
	AI_GATEWAY_ID?: string
	CAPABILITY_VECTOR_INDEX?: VectorizeIndex
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

type WorkersAiEmbeddingResponse = {
	data?: unknown
	shape?: unknown
}

export function getCapabilityVectorIndex(env: Env): VectorizeIndex | undefined {
	return (env as unknown as VectorizeRuntimeEnv).CAPABILITY_VECTOR_INDEX
}

/** Must match Vectorize index dimensions for production indexes. */
export const CAPABILITY_EMBEDDING_DIMENSIONS = 384
export const CAPABILITY_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5'
export const CAPABILITY_EMBEDDING_BATCH_SIZE = 8
export const CAPABILITY_EMBEDDING_MAX_INPUT_CHARS = 2_000

function truncateEmbeddingInput(text: string) {
	if (text.length <= CAPABILITY_EMBEDDING_MAX_INPUT_CHARS) return text
	return text.slice(0, CAPABILITY_EMBEDDING_MAX_INPUT_CHARS)
}

/**
 * L2-normalized pseudo-embedding for offline / test search (no Workers AI call).
 */
export function deterministicEmbedding(
	text: string,
	dimensions: number = CAPABILITY_EMBEDDING_DIMENSIONS,
): number[] {
	const normalized = text.toLowerCase().trim()
	const vec = new Float64Array(dimensions)
	for (let i = 0; i < dimensions; i += 1) {
		const h = fnv1a32(`${normalized}:${i}`)
		vec[i] = h / 2 ** 32 - 0.5
	}
	let norm = 0
	for (let i = 0; i < dimensions; i += 1) norm += vec[i]! * vec[i]!
	norm = Math.sqrt(norm) || 1
	for (let i = 0; i < dimensions; i += 1) vec[i]! /= norm
	return [...vec]
}

export function isCapabilitySearchOffline(env: Env): boolean {
	const runtime = env as unknown as Record<string, string | undefined>
	if (runtime['SENTRY_ENVIRONMENT'] === 'test') return true
	if (runtime['WRANGLER_IS_LOCAL_DEV'] === 'true') return true
	if (
		!getCapabilityVectorIndex(env) &&
		runtime['SENTRY_ENVIRONMENT'] !== 'production'
	)
		return true
	return false
}

export async function embedTextForVectorize(
	env: Env,
	text: string,
): Promise<Array<number>> {
	const rows = await embedTextsForVectorize(env, [text])
	return rows[0]!
}

export async function embedTextsForVectorize(
	env: Env,
	texts: ReadonlyArray<string>,
): Promise<Array<Array<number>>> {
	if (texts.length === 0) return []
	const truncatedTexts = texts.map((text) => truncateEmbeddingInput(text))

	const runtime = env as unknown as VectorizeRuntimeEnv
	if (!runtime.AI) {
		if (runtime.SENTRY_ENVIRONMENT !== 'production') {
			return truncatedTexts.map((text) => deterministicEmbedding(text))
		}
		throw new Error(
			'AI binding is required for capability embeddings in production.',
		)
	}
	const aiRuntime = runtime as VectorizeRuntimeEnv & { AI: Ai }

	const rows: Array<Array<number>> = []
	for (
		let offset = 0;
		offset < truncatedTexts.length;
		offset += CAPABILITY_EMBEDDING_BATCH_SIZE
	) {
		const batch = truncatedTexts.slice(
			offset,
			offset + CAPABILITY_EMBEDDING_BATCH_SIZE,
		)
		rows.push(...(await embedTextBatchForVectorize(aiRuntime, batch)))
	}
	return rows
}

async function runWorkersAiEmbeddingRequest(
	runtime: VectorizeRuntimeEnv & { AI: Ai },
	texts: ReadonlyArray<string>,
	options?: { gateway: { id: string } },
) {
	return (await runtime.AI.run(
		CAPABILITY_EMBEDDING_MODEL,
		{
			text: [...texts],
			pooling: 'cls',
		},
		options,
	)) as WorkersAiEmbeddingResponse
}

async function embedTextBatchForVectorize(
	runtime: VectorizeRuntimeEnv & { AI: Ai },
	texts: ReadonlyArray<string>,
) {
	const gatewayId = runtime.AI_GATEWAY_ID?.trim()
	if (gatewayId) {
		try {
			const response = await runWorkersAiEmbeddingRequest(runtime, texts, {
				gateway: { id: gatewayId },
			})
			return parseWorkersAiEmbeddingResponse(response, texts.length)
		} catch (error) {
			console.warn(
				JSON.stringify({
					message:
						'Workers AI Gateway embedding request failed; retrying direct Workers AI',
					gatewayId,
					error: getErrorMessage(error),
				}),
			)
			try {
				const response = await runWorkersAiEmbeddingRequest(runtime, texts)
				return parseWorkersAiEmbeddingResponse(response, texts.length)
			} catch (directError) {
				throw new Error(
					`Workers AI embedding request failed after AI Gateway fallback. Gateway error: ${getErrorMessage(error)}. Direct error: ${getErrorMessage(directError)}`,
				)
			}
		}
	}

	const response = await runWorkersAiEmbeddingRequest(runtime, texts)
	return parseWorkersAiEmbeddingResponse(response, texts.length)
}

function parseWorkersAiEmbeddingResponse(
	response: WorkersAiEmbeddingResponse,
	expectedRows: number,
): Array<Array<number>> {
	if (!Array.isArray(response.data)) {
		throw new Error('Workers AI embedding response did not include data rows.')
	}
	if (response.data.length !== expectedRows) {
		throw new Error(
			`Workers AI embedding response row count mismatch: expected ${expectedRows}, received ${response.data.length}.`,
		)
	}
	if (Array.isArray(response.shape)) {
		const [rows, dimensions] = response.shape
		if (
			rows !== expectedRows ||
			dimensions !== CAPABILITY_EMBEDDING_DIMENSIONS
		) {
			throw new Error(
				`Workers AI embedding response shape mismatch: expected [${expectedRows}, ${CAPABILITY_EMBEDDING_DIMENSIONS}], received ${JSON.stringify(response.shape)}.`,
			)
		}
	}

	return response.data.map((row, rowIndex) => {
		if (!Array.isArray(row)) {
			throw new Error(`Workers AI embedding row ${rowIndex} is not an array.`)
		}
		if (row.length !== CAPABILITY_EMBEDDING_DIMENSIONS) {
			throw new Error(
				`Workers AI embedding row ${rowIndex} dimension mismatch: expected ${CAPABILITY_EMBEDDING_DIMENSIONS}, received ${row.length}.`,
			)
		}
		return row.map((value, columnIndex) => {
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw new Error(
					`Workers AI embedding value at row ${rowIndex}, column ${columnIndex} is not a finite number.`,
				)
			}
			return value
		})
	})
}
