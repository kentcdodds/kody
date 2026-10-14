import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import {
	isRepoPushQueueSourceId,
	repoPushQueueSourceIdHeader,
	repoPushQueueV1Path,
} from '@kody-internal/shared/repo-push-queue-protocol.ts'
import {
	RepoPushQueue,
	repoPushQueueRetryResponse,
	type RepoPushQueueEvent,
	type RepoPushQueueStore,
} from './repo-push-queue.ts'

export type PushQueueWorkerEnv = {
	REPO_PUSH_QUEUE_V1: DurableObjectNamespace
	APP_COMMIT_SHA?: string
}

function chunkKey(entryId: string, index: number) {
	return `chunk:${entryId}:${String(index).padStart(6, '0')}`
}

export function createDurableObjectPushQueueStore(
	storage: DurableObjectStorage,
): RepoPushQueueStore {
	return {
		async putChunk(entryId, index, bytes) {
			await storage.put(chunkKey(entryId, index), bytes)
		},
		async getChunk(entryId, index) {
			return await storage.get<Uint8Array>(chunkKey(entryId, index))
		},
		async deleteEntry(entryId, chunkCount) {
			const keys = Array.from({ length: chunkCount }, (_, index) =>
				chunkKey(entryId, index),
			)
			// storage.delete accepts at most 128 keys per call.
			for (let start = 0; start < keys.length; start += 128) {
				await storage.delete(keys.slice(start, start + 128))
			}
		},
		async sync() {
			await storage.sync()
		},
	}
}

function logQueueEvent(event: RepoPushQueueEvent) {
	console.log(
		JSON.stringify({ message: `repo-push-queue-${event.event}`, ...event }),
	)
}

/**
 * One instance per repo source id (`idFromName(sourceId)`), shared by every
 * origin isolate. Versioned class name: a breaking change ships as
 * `RepoPushQueueV2` and V1 objects drain naturally.
 */
export class RepoPushQueueV1 extends DurableObject<PushQueueWorkerEnv> {
	readonly #queue: RepoPushQueue

	constructor(ctx: DurableObjectState, env: PushQueueWorkerEnv) {
		super(ctx, env)
		this.#queue = new RepoPushQueue({
			store: createDurableObjectPushQueueStore(ctx.storage),
			fetch: (url, init) => fetch(url, init),
			log: logQueueEvent,
		})
		// A fresh instance has no live waiters or tokens, so anything stored
		// belongs to a replaced instance whose callers already got a 503.
		void ctx.blockConcurrencyWhile(async () => {
			await ctx.storage.deleteAll()
		})
	}

	override async fetch(request: Request): Promise<Response> {
		return this.#queue.handle(request)
	}
}

export async function routeToRepoPushQueue(
	request: Request,
	namespace: DurableObjectNamespace,
): Promise<Response> {
	const url = new URL(request.url)
	if (request.method !== 'POST' || url.pathname !== repoPushQueueV1Path) {
		return new Response('Not found', { status: 404 })
	}
	const sourceId = request.headers.get(repoPushQueueSourceIdHeader)
	if (!isRepoPushQueueSourceId(sourceId)) {
		return new Response('Invalid push queue source id.', { status: 400 })
	}
	if (!request.headers.get('Authorization')) {
		return new Response('Missing Artifacts credentials.', { status: 401 })
	}
	try {
		const stub = namespace.get(namespace.idFromName(sourceId))
		return await stub.fetch(request)
	} catch (error) {
		console.error(
			JSON.stringify({
				message: 'repo-push-queue-stub-failed',
				sourceId,
				error: error instanceof Error ? error.message : String(error),
			}),
		)
		return repoPushQueueRetryResponse('unavailable')
	}
}

/**
 * Service-binding-only entrypoint (origin `REPO_PUSH_QUEUE`). Named
 * entrypoints are not reachable from the public internet; the default
 * export only serves `/health`.
 */
export class RepoPushQueueGateway extends WorkerEntrypoint<PushQueueWorkerEnv> {
	override async fetch(request: Request): Promise<Response> {
		return routeToRepoPushQueue(request, this.env.REPO_PUSH_QUEUE_V1)
	}
}

export function handlePushQueueHealthRequest(
	request: Request,
	env: Pick<PushQueueWorkerEnv, 'APP_COMMIT_SHA'>,
): Response {
	const url = new URL(request.url)
	if (url.pathname !== '/health') {
		return new Response('Not found', { status: 404 })
	}
	return Response.json(
		{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

export default {
	fetch(request: Request, env: PushQueueWorkerEnv) {
		return handlePushQueueHealthRequest(request, env)
	},
} satisfies ExportedHandler<PushQueueWorkerEnv>
