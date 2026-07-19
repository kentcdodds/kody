import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { listAdminAccountRows } from '#app/permissions-db.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { invokePackageSubscription } from './service.ts'

type LoadedAdminPackageSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

const adminPackageSubscriptionConcurrency = 5

async function mapSettledInChunks<T, TResult>(
	items: ReadonlyArray<T>,
	mapper: (item: T) => Promise<TResult>,
) {
	const results: Array<PromiseSettledResult<TResult>> = []
	for (const itemChunk of chunkArray(
		items,
		adminPackageSubscriptionConcurrency,
	)) {
		results.push(...(await Promise.allSettled(itemChunk.map(mapper))))
	}
	return results
}

function isMissingSavedPackagesTableError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.toLowerCase().includes('no such table: saved_packages')
	)
}

async function listAdminStableUserIds(db: D1Database) {
	const rows = await listAdminAccountRows(db)
	const settled = await mapSettledInChunks(
		rows,
		async (row) => await resolveUserStableId(row),
	)
	const stableIds = new Set<string>()
	for (const result of settled) {
		if (result.status === 'fulfilled' && result.value) {
			stableIds.add(result.value)
			continue
		}
		if (result.status === 'rejected') {
			console.warn('admin-package-subscription-user-id-resolution-failed', {
				error: result.reason,
			})
		}
	}
	return Array.from(stableIds)
}

async function loadMatchingSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: string
}) {
	let savedPackages: Array<SavedPackageRecord>
	try {
		savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	} catch (error) {
		if (isMissingSavedPackagesTableError(error)) return []
		throw error
	}
	const settled = await mapSettledInChunks(
		savedPackages,
		async (savedPackage) => {
			const loaded = await loadPackageManifestBySourceId({
				env: input.env as Env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			})
			const subscription = listPackageSubscriptions(loaded.manifest).find(
				(candidate) => candidate.topic === input.topic,
			)
			if (!subscription) return null
			return {
				savedPackage,
				subscription,
			} satisfies LoadedAdminPackageSubscription
		},
	)
	const subscriptions: Array<LoadedAdminPackageSubscription> = []
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') {
			if (result.value) subscriptions.push(result.value)
			continue
		}
		const savedPackage = savedPackages[index]
		console.warn('admin-package-subscription-manifest-load-failed', {
			topic: input.topic,
			packageId: savedPackage?.id,
			sourceId: savedPackage?.sourceId,
			error: result.reason,
		})
	}
	return subscriptions
}

/**
 * Fans an event out only to packages whose owners hold the admin role at
 * dispatch time. Discovery and invocation failures are isolated so one admin
 * package cannot prevent delivery attempts to its siblings.
 */
export async function dispatchAdminPackageSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	topic: string
	getParams: () => Record<string, unknown> | Promise<Record<string, unknown>>
	source: string
	buildIdempotencyKey: (savedPackage: SavedPackageRecord) => string
	actorTokenId?: string
}) {
	const adminUserIds = await listAdminStableUserIds(input.env.APP_DB)
	if (adminUserIds.length === 0) return []
	const discovered = await mapSettledInChunks(
		adminUserIds,
		async (userId) =>
			await loadMatchingSubscriptions({
				env: input.env,
				baseUrl: input.baseUrl,
				userId,
				topic: input.topic,
			}),
	)
	const subscriptions: Array<LoadedAdminPackageSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of discovered.entries()) {
		if (result.status === 'fulfilled') {
			subscriptions.push(...result.value)
			continue
		}
		console.warn('admin-package-subscription-discovery-failed', {
			topic: input.topic,
			userId: adminUserIds[index],
			error: result.reason,
		})
		discoveryErrors.push(result.reason)
	}
	if (subscriptions.length === 0) {
		if (discoveryErrors.length > 0) {
			throw new Error('Admin package subscription discovery failed.', {
				cause: discoveryErrors[0],
			})
		}
		return []
	}
	const params = await input.getParams()
	const invoked = await mapSettledInChunks(
		subscriptions,
		async ({ savedPackage }) => {
			const response = await invokePackageSubscription({
				env: input.env as Env,
				baseUrl: input.baseUrl,
				savedPackage,
				topic: input.topic,
				params,
				idempotencyKey: input.buildIdempotencyKey(savedPackage),
				source: input.source,
				actorTokenId: input.actorTokenId,
			})
			if (response.status < 200 || response.status >= 400) {
				console.warn('admin-package-subscription-handler-failed', {
					topic: input.topic,
					packageId: savedPackage.id,
					status: response.status,
				})
			}
			return response
		},
	)
	const responses = invoked.map((result, index) => {
		if (result.status === 'fulfilled') return result.value
		console.warn('admin-package-subscription-invocation-failed', {
			topic: input.topic,
			packageId: subscriptions[index]?.savedPackage.id,
			error: result.reason,
		})
		return null
	})
	if (discoveryErrors.length > 0) {
		throw new Error('Admin package subscription discovery failed.', {
			cause: discoveryErrors[0],
		})
	}
	return responses
}
