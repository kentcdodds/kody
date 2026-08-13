import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import {
	getSavedPackageById,
	listSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getArtifactsNamespace } from './artifacts.ts'
import {
	type CloudflareArtifactsRepoEvent,
	type RepoSubscriptionTopic,
	isSessionArtifactRepoName,
	parseCloudflareArtifactsRepoEvent,
	repoCreatedTopic,
	repoDeletedTopic,
	repoPushedTopic,
	topicForArtifactsRepoEvent,
} from './artifacts-events.ts'
import { getEntitySourceByRepoId } from './entity-sources.ts'
import { type EntitySourceRow } from './types.ts'
import { getUserRepoById } from './user-repos.ts'

type LoadedRepoSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

export type RepoSubscriptionEntity = {
	source_id: string
	repo_id: string
	entity_kind: EntitySourceRow['entity_kind']
	entity_id: string
	name: string | null
	kody_id: string | null
}

export type RepoPushedSubscriptionEnvelope = {
	event: typeof repoPushedTopic
	repo: RepoSubscriptionEntity
	push: {
		ref: string
		before: string
		after: string
		total_commits_count: number
		commits_truncated: boolean
		commits: Array<{
			id: string
			message: string
			message_truncated: boolean
			timestamp: string
			author: { name: string; email: string }
			committer: { name: string; email: string }
			parents: Array<string>
		}>
	}
	artifacts: {
		namespace: string
		event_timestamp: string
		event_subscription_id: string
	}
}

export type RepoLifecycleSubscriptionEnvelope = {
	event: typeof repoCreatedTopic | typeof repoDeletedTopic
	repo: RepoSubscriptionEntity
	artifacts: {
		namespace: string
		event_timestamp: string
		event_subscription_id: string
		default_branch: string
		description: string | null
		cloudflare_repo_id: string
	}
}

async function resolveRepoSubscriptionEntity(input: {
	env: Pick<Env, 'APP_DB'>
	source: EntitySourceRow
}): Promise<RepoSubscriptionEntity> {
	let name: string | null = null
	let kodyId: string | null = null
	switch (input.source.entity_kind) {
		case 'repo': {
			const userRepo = await getUserRepoById(input.env.APP_DB, {
				userId: input.source.user_id,
				repoId: input.source.entity_id,
			})
			name = userRepo?.name ?? null
			break
		}
		case 'package': {
			const savedPackage = await getSavedPackageById(input.env.APP_DB, {
				userId: input.source.user_id,
				packageId: input.source.entity_id,
			})
			name = savedPackage?.name ?? null
			kodyId = savedPackage?.kodyId ?? null
			break
		}
		case 'job':
			break
		default: {
			const exhaustive: never = input.source.entity_kind
			throw new Error(`Unsupported entity kind: ${exhaustive}`)
		}
	}
	return {
		source_id: input.source.id,
		repo_id: input.source.repo_id,
		entity_kind: input.source.entity_kind,
		entity_id: input.source.entity_id,
		name,
		kody_id: kodyId,
	}
}

function buildRepoPushedPayload(input: {
	repo: RepoSubscriptionEntity
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.pushed' }
	>
}): RepoPushedSubscriptionEnvelope {
	return {
		event: repoPushedTopic,
		repo: input.repo,
		push: {
			ref: input.event.payload.ref,
			before: input.event.payload.before,
			after: input.event.payload.after,
			total_commits_count: input.event.payload.totalCommitsCount,
			commits_truncated: input.event.payload.commitsTruncated,
			commits: input.event.payload.commits.map((commit) => ({
				id: commit.id,
				message: commit.message,
				message_truncated: commit.messageTruncated,
				timestamp: commit.timestamp,
				author: commit.author,
				committer: commit.committer,
				parents: commit.parents,
			})),
		},
		artifacts: {
			namespace: input.event.source.namespace,
			event_timestamp: input.event.metadata.eventTimestamp,
			event_subscription_id: input.event.metadata.eventSubscriptionId,
		},
	}
}

function buildRepoLifecyclePayload(input: {
	topic: typeof repoCreatedTopic | typeof repoDeletedTopic
	repo: RepoSubscriptionEntity
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.created' | 'cf.artifacts.repo.deleted' }
	>
}): RepoLifecycleSubscriptionEnvelope {
	return {
		event: input.topic,
		repo: input.repo,
		artifacts: {
			namespace: input.event.source.namespace,
			event_timestamp: input.event.metadata.eventTimestamp,
			event_subscription_id: input.event.metadata.eventSubscriptionId,
			default_branch: input.event.payload.defaultBranch,
			description: input.event.payload.description ?? null,
			cloudflare_repo_id: input.event.payload.repoId,
		},
	}
}

function buildSubscriptionIdempotencyKey(input: {
	topic: RepoSubscriptionTopic
	repoId: string
	packageId: string
	event: CloudflareArtifactsRepoEvent
}) {
	switch (input.topic) {
		case repoPushedTopic: {
			if (input.event.type !== 'cf.artifacts.repo.pushed') {
				throw new Error('repo.pushed idempotency requires a pushed event')
			}
			// Omit source.type so account-level and leftover repo-scoped
			// publications of the same push collapse to one invocation.
			return `repo-push:${input.repoId}:${input.event.payload.after}:${input.event.payload.ref}:${input.packageId}`
		}
		case repoCreatedTopic:
		case repoDeletedTopic:
			return `repo-lifecycle:${input.topic}:${input.repoId}:${input.event.metadata.eventTimestamp}:${input.packageId}`
		default: {
			const exhaustive: never = input.topic
			throw new Error(`Unsupported repo subscription topic: ${exhaustive}`)
		}
	}
}

async function loadMatchingRepoSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: RepoSubscriptionTopic
}) {
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
			subscriptions: [] as Array<LoadedRepoSubscription>,
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
			return { savedPackage, subscription } satisfies LoadedRepoSubscription
		}),
	)
	const subscriptions: Array<LoadedRepoSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') {
			if (result.value) subscriptions.push(result.value)
			continue
		}
		const savedPackage = savedPackages[index]
		console.warn('Failed to load package manifest for repo subscription', {
			sourceId: savedPackage?.sourceId,
			packageId: savedPackage?.id,
			error: result.reason,
		})
		discoveryErrors.push(result.reason)
	}
	return { subscriptions, discoveryErrors }
}

function buildEventParams(input: {
	topic: RepoSubscriptionTopic
	repo: RepoSubscriptionEntity
	providerEvent: CloudflareArtifactsRepoEvent
}) {
	switch (input.topic) {
		case repoPushedTopic: {
			if (input.providerEvent.type !== 'cf.artifacts.repo.pushed') {
				throw new Error('repo.pushed payload requires a pushed event')
			}
			return buildRepoPushedPayload({
				repo: input.repo,
				event: input.providerEvent,
			})
		}
		case repoCreatedTopic:
		case repoDeletedTopic: {
			if (
				input.providerEvent.type !== 'cf.artifacts.repo.created' &&
				input.providerEvent.type !== 'cf.artifacts.repo.deleted'
			) {
				throw new Error('repo lifecycle payload requires a lifecycle event')
			}
			return buildRepoLifecyclePayload({
				topic: input.topic,
				repo: input.repo,
				event: input.providerEvent,
			})
		}
		default: {
			const exhaustive: never = input.topic
			throw new Error(`Unsupported repo subscription topic: ${exhaustive}`)
		}
	}
}

export async function dispatchRepoSubscriptionEvents(input: {
	env: Env
	providerEvent: CloudflareArtifactsRepoEvent
	source: EntitySourceRow
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const topic = topicForArtifactsRepoEvent(input.providerEvent)
	const baseUrl = getAppBaseUrl({ env: input.env })
	const repo = await resolveRepoSubscriptionEntity({
		env: input.env,
		source: input.source,
	})
	const eventPayload = buildEventParams({
		topic,
		repo,
		providerEvent: input.providerEvent,
	})

	const { subscriptions, discoveryErrors } =
		await loadMatchingRepoSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.source.user_id,
			topic,
		})

	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env,
						baseUrl,
						savedPackage,
						topic,
						params: eventPayload as unknown as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							topic,
							repoId: input.source.repo_id,
							packageId: savedPackage.id,
							event: input.providerEvent,
						}),
						source: 'repo',
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
			console.error('repo-subscription-invoke-failed', {
				topic,
				repoId: input.source.repo_id,
				error: result.reason,
			})
		}
	}
	if (discoveryErrors.length > 0) {
		throw new Error('Repo package subscription discovery was incomplete.', {
			cause: discoveryErrors[0],
		})
	}
	const invocationError = settled.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	)
	if (invocationError) {
		throw new Error('Repo package subscription dispatch was incomplete.', {
			cause: invocationError.reason,
		})
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

export type ProcessArtifactsRepoEventResult =
	| { outcome: 'invalid'; providerEvent: null }
	| { outcome: 'ignored'; providerEvent: CloudflareArtifactsRepoEvent }
	| {
			outcome: 'unmatched'
			providerEvent: CloudflareArtifactsRepoEvent
	  }
	| {
			outcome: 'dispatched'
			providerEvent: CloudflareArtifactsRepoEvent
			source: EntitySourceRow
	  }

export async function processCloudflareArtifactsRepoEvent(input: {
	env: Env
	body: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<ProcessArtifactsRepoEventResult> {
	const providerEvent = parseCloudflareArtifactsRepoEvent(input.body)
	if (!providerEvent) {
		return { outcome: 'invalid', providerEvent: null }
	}

	const expectedNamespace = getArtifactsNamespace(input.env)
	if (providerEvent.source.namespace !== expectedNamespace) {
		return { outcome: 'ignored', providerEvent }
	}
	if (isSessionArtifactRepoName(providerEvent.source.repoName)) {
		return { outcome: 'ignored', providerEvent }
	}

	const source = await getEntitySourceByRepoId(
		input.env.APP_DB,
		providerEvent.source.repoName,
	)
	if (!source) {
		return { outcome: 'unmatched', providerEvent }
	}

	await dispatchRepoSubscriptionEvents({
		env: input.env,
		providerEvent,
		source,
		waitUntil: input.waitUntil,
	})
	return { outcome: 'dispatched', providerEvent, source }
}
