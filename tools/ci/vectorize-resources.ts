import { CAPABILITY_EMBEDDING_DIMENSIONS } from '#worker/vectorize/embedding.ts'
import {
	CloudflareResourceError,
	cloudflareApiRequest,
} from './resource-utils.ts'

/**
 * Every metadata property a Vectorize query filters on. Vectorize only filters
 * on properties that have a metadata index, so a freshly created index without
 * these silently returns no matches. Keep in sync with the metadata contracts
 * in docs/contributing/architecture/data-storage.md.
 */
const vectorizeMetadataIndexProperties = [
	'kind',
	'userId',
	'status',
	'category',
	'domain',
] as const

const vectorizeIndexMetric = 'cosine'

type VectorizeIndexInfo = { name: string }

type VectorizeMetadataIndexList = {
	metadataIndexes?: Array<{ propertyName: string; indexType: string }>
}

type VectorizeClient = {
	accountId: string
	apiToken: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}

/**
 * Look the index up by name rather than scanning the list endpoint, which
 * pages once the account holds many preview indexes.
 */
function isTransientVectorizeGone(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	// A just-deleted (or not-yet-visible) index answers 410
	// vectorize.index.deleted, not only 404.
	return /Cloudflare API request failed \((404|410)\)/.test(message)
}

async function vectorizeIndexExists(client: VectorizeClient, name: string) {
	try {
		const response = await cloudflareApiRequest<VectorizeIndexInfo>({
			...client,
			pathname: `/vectorize/v2/indexes/${encodeURIComponent(name)}`,
			method: 'GET',
		})
		return response.result?.name === name
	} catch (error) {
		if (isTransientVectorizeGone(error)) return false
		throw error
	}
}

/**
 * GET can succeed while metadata_index/list still returns 410 after a
 * recreate. Treat the index as ready only when metadata listing works.
 */
async function vectorizeIndexReady(client: VectorizeClient, name: string) {
	if (!(await vectorizeIndexExists(client, name))) return false
	try {
		await cloudflareApiRequest<VectorizeMetadataIndexList>({
			...client,
			pathname: `/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/list`,
			method: 'GET',
		})
		return true
	} catch (error) {
		if (isTransientVectorizeGone(error)) return false
		throw error
	}
}

const vectorizeRecreateVisibleDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000]

/**
 * Re-creating a name that was deleted minutes earlier (a preview redeploy
 * after its cleanup) succeeds, but reads keep answering 410
 * vectorize.index.deleted for a while. Wait until the index is operable
 * (metadata list succeeds) before configuring it.
 */
async function waitForCreatedVectorizeIndex(
	client: VectorizeClient,
	name: string,
) {
	const wait =
		client.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	if (await vectorizeIndexReady(client, name)) return
	for (const delayMs of vectorizeRecreateVisibleDelaysMs) {
		console.error(
			`Waiting ${String(delayMs)}ms for new Vectorize index ${name} to be readable.`,
		)
		await wait(delayMs)
		if (await vectorizeIndexReady(client, name)) return
	}
	throw new Error(
		`Vectorize index ${name} did not become ready (index GET or metadata_index/list kept returning 404/410) past the wait window.`,
	)
}

async function ensureVectorizeMetadataIndexes(
	client: VectorizeClient,
	name: string,
) {
	const response = await cloudflareApiRequest<VectorizeMetadataIndexList>({
		...client,
		pathname: `/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/list`,
		method: 'GET',
	})
	const existing = new Set(
		(response.result?.metadataIndexes ?? []).map((entry) => entry.propertyName),
	)
	for (const propertyName of vectorizeMetadataIndexProperties) {
		if (existing.has(propertyName)) continue
		await cloudflareApiRequest({
			...client,
			pathname: `/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/create`,
			method: 'POST',
			body: { propertyName, indexType: 'string' },
		})
		console.error(`Created Vectorize metadata index: ${name}.${propertyName}`)
	}
}

/**
 * Create the Vectorize index (384-dimension cosine, matching
 * `CAPABILITY_EMBEDDING_DIMENSIONS`) when missing, then make sure every
 * metadata index the query filters need exists. Idempotent.
 */
export async function ensureVectorizeIndex(
	input: VectorizeClient & { name: string },
) {
	if (input.dryRun) {
		console.error(`[dry-run] ensure Vectorize index: ${input.name}`)
		return { name: input.name }
	}
	try {
		if (await vectorizeIndexExists(input, input.name)) {
			console.error(`Vectorize index exists: ${input.name}`)
		} else {
			await cloudflareApiRequest({
				...input,
				pathname: '/vectorize/v2/indexes',
				method: 'POST',
				body: {
					name: input.name,
					config: {
						dimensions: CAPABILITY_EMBEDDING_DIMENSIONS,
						metric: vectorizeIndexMetric,
					},
				},
			})
			console.error(`Created Vectorize index: ${input.name}`)
		}
		// Wait even when GET already succeeded: metadata_index/list can still
		// answer 410 briefly after create/recreate on a recycled preview name.
		await waitForCreatedVectorizeIndex(input, input.name)
		await ensureVectorizeMetadataIndexes(input, input.name)
	} catch (error) {
		if (error instanceof CloudflareResourceError) throw error
		throw new CloudflareResourceError(
			'vectorize',
			input.name,
			`Failed to ensure Vectorize index ${input.name}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		)
	}
	return { name: input.name }
}

/**
 * Delete a Vectorize index. An index that is already gone counts as success,
 * and the post-delete lookup is the source of truth for whether it is gone.
 */
export async function deleteVectorizeIndex(
	input: VectorizeClient & { name: string },
) {
	if (input.dryRun) {
		console.error(`[dry-run] delete Vectorize index: ${input.name}`)
		return
	}
	try {
		if (!(await vectorizeIndexExists(input, input.name))) {
			console.error(`Vectorize index already deleted: ${input.name}`)
			return
		}
		let deleteError: unknown
		try {
			await cloudflareApiRequest({
				...input,
				pathname: `/vectorize/v2/indexes/${encodeURIComponent(input.name)}`,
				method: 'DELETE',
			})
		} catch (error) {
			deleteError = error
		}
		if (await vectorizeIndexExists(input, input.name)) {
			throw deleteError ?? new Error('index still exists after delete')
		}
		console.error(`Deleted Vectorize index: ${input.name}`)
	} catch (error) {
		throw new CloudflareResourceError(
			'vectorize',
			input.name,
			`Failed to delete Vectorize index ${input.name}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		)
	}
}
