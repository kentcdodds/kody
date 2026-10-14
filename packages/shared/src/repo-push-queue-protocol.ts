/**
 * Wire contract between the origin plain-repo git proxy and the
 * `kody-push-queue` Worker (`RepoPushQueueV1`). Keep changes forward and
 * backward compatible: origin and the queue Worker deploy independently, so
 * either side may run a newer version during a rollout. Breaking changes ship
 * as a new Durable Object class (`RepoPushQueueV2`) and a new request path.
 */

export const repoPushQueueV1Path = '/v1/receive-pack'

/** Origin → queue: `entity_sources.id`, the Durable Object name. */
export const repoPushQueueSourceIdHeader = 'Kody-Push-Queue-Source-Id'
/** Origin → queue: absolute Artifacts `…/git-receive-pack` URL. */
export const repoPushQueueUpstreamHeader = 'Kody-Push-Queue-Upstream'

/** Queue → client: which receive-pack path served this push. */
export const repoPushQueuePathHeader = 'Kody-Push-Queue'
/** Pushes ahead of this one (running + waiting) when it landed in the queue. */
export const repoPushQueuePositionHeader = 'Kody-Push-Queue-Position'
/** Milliseconds from landing in the queue until the first Artifacts send. */
export const repoPushQueueWaitMsHeader = 'Kody-Push-Queue-Wait-Ms'
/** Artifacts sends for this push (more than 1 means busy retries). */
export const repoPushQueueAttemptsHeader = 'Kody-Push-Queue-Attempts'
/** Why the queue rejected a push: `timeout`, `full`, `unavailable`. */
export const repoPushQueueOutcomeHeader = 'Kody-Push-Queue-Outcome'

/** `Kody-Push-Queue` values. */
export const repoPushQueuePathQueued = 'v1'
export const repoPushQueuePathDirect = 'off'

/** Total per-push budget: landing, waiting for the turn, and busy retries. */
export const repoPushQueueBudgetMs = 90_000

/** Per-value DO storage cap is 2 MB; stay well under it. */
export const repoPushQueueChunkBytes = 1024 * 1024

export const repoPushQueueMaxEntries = 32
export const repoPushQueueMaxQueuedBytes = 256 * 1024 * 1024

/**
 * Packs at or under this size are read into memory before the Artifacts send,
 * so an in-flight send needs no storage access and survives a code-update
 * shutdown. Larger packs stream from storage to bound isolate memory.
 */
export const repoPushQueueInMemorySendBytes = 8 * 1024 * 1024

export const repoPushQueueRetryAfterSeconds = 2

/** `entity_sources.id` (crypto.randomUUID). */
const sourceIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isRepoPushQueueSourceId(value: string | null): value is string {
	return value !== null && sourceIdPattern.test(value)
}

export function isRepoPushQueueUpstreamUrl(value: string | null) {
	if (!value) return false
	try {
		const url = new URL(value)
		return (
			url.protocol === 'https:' && url.pathname.endsWith('/git-receive-pack')
		)
	} catch {
		return false
	}
}
