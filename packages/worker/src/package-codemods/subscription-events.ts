import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

export const packageCodemodAppliedTopic = 'package.codemod.applied'
export const packageCodemodRevertedTopic = 'package.codemod.reverted'

export type PackageCodemodSubscriptionTopic =
	| typeof packageCodemodAppliedTopic
	| typeof packageCodemodRevertedTopic

export type PackageCodemodSubscriptionEnvelope = {
	event: PackageCodemodSubscriptionTopic
	codemod: {
		id: string
		description: string
	}
	package: {
		package_id: string
		kody_id: string
	}
	run: {
		run_id: string
		item_id: string
	}
	changed_paths: Array<string>
	before_commit: string | null
	after_commit: string | null
}

export type LoadedCodemodSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

function buildPackageCodemodEventPayload(input: {
	topic: PackageCodemodSubscriptionTopic
	codemodId: string
	codemodDescription: string
	packageId: string
	kodyId: string
	runId: string
	itemId: string
	changedPaths: Array<string>
	beforeCommit: string | null
	afterCommit: string | null
}): PackageCodemodSubscriptionEnvelope {
	return {
		event: input.topic,
		codemod: {
			id: input.codemodId,
			description: input.codemodDescription,
		},
		package: {
			package_id: input.packageId,
			kody_id: input.kodyId,
		},
		run: {
			run_id: input.runId,
			item_id: input.itemId,
		},
		changed_paths: input.changedPaths,
		before_commit: input.beforeCommit,
		after_commit: input.afterCommit,
	}
}

function buildSubscriptionIdempotencyKey(input: {
	itemId: string
	topic: PackageCodemodSubscriptionTopic
	packageId: string
}) {
	return `package-codemod:${input.itemId}:${input.topic}:${input.packageId}`
}

export async function loadMatchingCodemodSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: PackageCodemodSubscriptionTopic
}): Promise<{
	subscriptions: Array<LoadedCodemodSubscription>
	discoveryErrors: Array<unknown>
}> {
	let savedPackages: Array<SavedPackageRecord>
	try {
		savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	} catch (error) {
		const missingTable =
			error instanceof Error &&
			error.message.includes('no such table: saved_packages')
		return {
			subscriptions: [],
			discoveryErrors: missingTable ? [] : [error],
		}
	}
	const settled = await Promise.allSettled(
		savedPackages.map(async (savedPackage) => {
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
			} satisfies LoadedCodemodSubscription
		}),
	)
	const subscriptions: Array<LoadedCodemodSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') {
			if (result.value) subscriptions.push(result.value)
			continue
		}
		const savedPackage = savedPackages[index]
		console.warn(
			'Failed to load package manifest for package codemod subscription',
			{
				sourceId: savedPackage?.sourceId,
				packageId: savedPackage?.id,
				topic: input.topic,
				error: result.reason,
			},
		)
		discoveryErrors.push(result.reason)
	}
	return { subscriptions, discoveryErrors }
}

export function createPackageCodemodSubscriptionCache() {
	const cache = new Map<
		string,
		Promise<{
			subscriptions: Array<LoadedCodemodSubscription>
			discoveryErrors: Array<unknown>
		}>
	>()
	return {
		load(input: {
			env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
			baseUrl: string
			userId: string
			topic: PackageCodemodSubscriptionTopic
		}) {
			const key = `${input.userId}:${input.topic}`
			const existing = cache.get(key)
			if (existing) return existing
			const pending = loadMatchingCodemodSubscriptions(input)
			cache.set(key, pending)
			return pending
		},
	}
}

async function invokeCodemodSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	baseUrl: string
	topic: PackageCodemodSubscriptionTopic
	itemId: string
	eventPayload: PackageCodemodSubscriptionEnvelope
	subscriptions: Array<LoadedCodemodSubscription>
	discoveryErrors: Array<unknown>
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				input.subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl: input.baseUrl,
						savedPackage,
						topic: input.topic,
						params: input.eventPayload as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							itemId: input.itemId,
							topic: input.topic,
							packageId: savedPackage.id,
						}),
						source: 'package-codemods',
						waitUntil: input.waitUntil,
					})
					const retryableCode =
						readPreExecutionPackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Retryable package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				}),
			),
	)
	for (const result of settled) {
		if (result.status === 'rejected') {
			console.warn('package codemod subscription invoke failed', {
				topic: input.topic,
				itemId: input.itemId,
				error: result.reason,
			})
		}
	}
	if (input.discoveryErrors.length > 0) {
		console.warn('package codemod subscription discovery incomplete', {
			topic: input.topic,
			itemId: input.itemId,
			errorCount: input.discoveryErrors.length,
			error: input.discoveryErrors[0],
		})
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

/**
 * Fan a package codemod apply/revert event out to the owning user's packages
 * that declare the topic. Best-effort: never throws into the codemod engine.
 * When `waitUntil` is provided, the fan-out is scheduled there and this
 * returns immediately.
 */
export async function dispatchPackageCodemodSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	topic: PackageCodemodSubscriptionTopic
	codemodId: string
	codemodDescription: string
	packageId: string
	kodyId: string
	runId: string
	itemId: string
	changedPaths: Array<string>
	beforeCommit: string | null
	afterCommit: string | null
	waitUntil?: (promise: Promise<unknown>) => void
	subscriptionCache?: ReturnType<typeof createPackageCodemodSubscriptionCache>
}) {
	const run = async () => {
		try {
			const baseUrl = getAppBaseUrl({ env: input.env })
			const loader =
				input.subscriptionCache?.load.bind(input.subscriptionCache) ??
				loadMatchingCodemodSubscriptions
			const { subscriptions, discoveryErrors } = await loader({
				env: input.env,
				baseUrl,
				userId: input.userId,
				topic: input.topic,
			})
			const eventPayload = buildPackageCodemodEventPayload({
				topic: input.topic,
				codemodId: input.codemodId,
				codemodDescription: input.codemodDescription,
				packageId: input.packageId,
				kodyId: input.kodyId,
				runId: input.runId,
				itemId: input.itemId,
				changedPaths: input.changedPaths,
				beforeCommit: input.beforeCommit,
				afterCommit: input.afterCommit,
			})
			return await invokeCodemodSubscriptions({
				env: input.env,
				baseUrl,
				topic: input.topic,
				itemId: input.itemId,
				eventPayload,
				subscriptions,
				discoveryErrors,
				waitUntil: input.waitUntil,
			})
		} catch (error) {
			console.warn('package codemod subscription dispatch failed', {
				topic: input.topic,
				itemId: input.itemId,
				error,
			})
			return []
		}
	}

	if (input.waitUntil) {
		input.waitUntil(run())
		return []
	}
	return await run()
}
