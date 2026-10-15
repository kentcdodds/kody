import { parseListingOwnerUsername } from '#universal/community-links.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { deliverCommunityForkUpstreamUpdatedAlias } from '#worker/community/fork-upstream-updated-package-subscriptions.ts'
import { type CommunityListingRelease } from '#worker/community/fork-upstream-updated-subscription-event.ts'
import { getCommunityPackageHref } from '#worker/community/package-url.ts'
import {
	getActiveCommunityListingWithPublisherUsername,
	listCommunityForksByListingId,
} from '#worker/community/repo.ts'
import {
	loadMatchingPackageSubscriptions,
	type LoadedPackageSubscription,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { packageEventFiltersMatchPayload } from '#worker/package-invocations/subscription-dispatch.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import {
	loadFollowTargetSnapshot,
	resolveFollowDeliveryAccess,
} from './access.ts'
import {
	buildFollowPublishedEvent,
	buildFollowPushedEvent,
	followPublishedEventId,
	followPushedEventId,
} from './events.ts'
import { markFollowDeliverySkip, pauseFollow } from './repo.ts'
import {
	followPublishedTopic,
	followPushedTopic,
	followZeroCreditsSkipReason,
	type FollowPushPending,
	type FollowRecord,
	type FollowTargetSnapshot,
} from './types.ts'

const followSubscriptionActorTokenId = 'internal:follow-subscriptions'

export type FollowPublishedDelivery = {
	previousCommit: string | null
	publishedCommit: string
	publishedAt: string
	listing?: {
		listingId: string
		previous: CommunityListingRelease
		current: CommunityListingRelease
	} | null
}

export type FollowDeliveryHooks = {
	loadTarget?: typeof loadFollowTargetSnapshot
	resolveAccess?: typeof resolveFollowDeliveryAccess
	loadSubscriptions?: (input: {
		env: Env
		userId: string
		topic: string
		payload: Record<string, unknown>
	}) => Promise<Array<LoadedPackageSubscription>>
	invoke?: typeof invokePackageSubscription
}

/**
 * Deliver `follow.published` or `follow.pushed` to active follows.
 * Lost create-level access pauses the row. Push without `package:read`
 * (or org-wide `package:read` for a plain repo) is skipped and the follow
 * stays active. A 429 from invocation is recorded as `zero_credits` and
 * does not throw.
 */
export async function deliverFollowRecords(input: {
	env: Env
	follows: ReadonlyArray<FollowRecord>
	now: Date
	published?: FollowPublishedDelivery
	pushed?: FollowPushPending
	hooks?: FollowDeliveryHooks
}): Promise<void> {
	const mode = input.published ? 'published' : input.pushed ? 'pushed' : null
	if (!mode) return
	const nowIso = input.now.toISOString()
	for (const follow of input.follows) {
		if (follow.status !== 'active') continue
		try {
			await deliverOneFollow({
				env: input.env,
				follow,
				nowIso,
				published: input.published,
				pushed: input.pushed,
				hooks: input.hooks,
			})
		} catch (error) {
			console.error('follow-delivery-failed', {
				followId: follow.id,
				error,
			})
		}
	}
}

async function deliverOneFollow(input: {
	env: Env
	follow: FollowRecord
	nowIso: string
	published?: FollowPublishedDelivery
	pushed?: FollowPushPending
	hooks?: FollowDeliveryHooks
}) {
	const loadTarget = input.hooks?.loadTarget ?? loadFollowTargetSnapshot
	const resolveAccess =
		input.hooks?.resolveAccess ?? resolveFollowDeliveryAccess
	const target = await loadTarget(input.env.APP_DB, input.follow)
	if (!target) {
		await pauseFollow(input.env.APP_DB, {
			id: input.follow.id,
			pausedAt: input.nowIso,
		})
		return
	}
	const access = await resolveAccess({
		env: input.env,
		creatorUserId: input.follow.creatorUserId,
		target,
	})
	if (!access.canCreate) {
		await pauseFollow(input.env.APP_DB, {
			id: input.follow.id,
			pausedAt: input.nowIso,
		})
		return
	}
	if (input.pushed) {
		if (!access.canPush) return
		const eventId = followPushedEventId(input.pushed)
		const payload = buildFollowPushedEvent({
			eventId,
			target,
			pending: input.pushed,
		})
		await invokeFollowTopic({
			env: input.env,
			follow: input.follow,
			nowIso: input.nowIso,
			topic: followPushedTopic,
			payload,
			hooks: input.hooks,
			idempotencyKey: (packageId) =>
				`follow-pushed:${input.follow.id}:${input.pushed?.windowStartedAt}:${input.pushed?.afterCommit}:${packageId}`,
		})
		return
	}
	if (!input.published) return
	const eventId = followPublishedEventId({
		packageId: input.follow.targetId,
		publishedCommit: input.published.publishedCommit,
	})
	const payload = buildFollowPublishedEvent({
		eventId,
		targetName: target.name,
		previousCommit: input.published.previousCommit,
		publishedCommit: input.published.publishedCommit,
		publishedAt: input.published.publishedAt,
	})
	const publishedResult = await invokeFollowTopic({
		env: input.env,
		follow: input.follow,
		nowIso: input.nowIso,
		topic: followPublishedTopic,
		payload,
		hooks: input.hooks,
		idempotencyKey: (packageId) =>
			`follow-published:${input.follow.id}:${input.published?.publishedCommit}:${packageId}`,
	})
	const aliasResult = await deliverForkAlias({
		env: input.env,
		follow: input.follow,
		target,
		published: input.published,
		eventId,
	})
	if (publishedResult === 'zero_credits' || aliasResult === 'zero_credits') {
		await markFollowDeliverySkip(input.env.APP_DB, {
			id: input.follow.id,
			reason: followZeroCreditsSkipReason,
			skippedAt: input.nowIso,
		})
	}
}

async function deliverForkAlias(input: {
	env: Env
	follow: FollowRecord
	target: FollowTargetSnapshot
	published: FollowPublishedDelivery
	eventId: string
}): Promise<'delivered' | 'zero_credits' | 'none' | 'failed'> {
	const listing = input.published.listing
	if (!listing) return 'none'
	if (listing.previous.pinnedCommit === listing.current.pinnedCommit) {
		return 'none'
	}
	if (input.target.kind !== 'package') return 'none'
	const projection = await loadListingProjection(input.env, listing.listingId)
	if (!projection) return 'none'
	const forks = await listCommunityForksByListingId(input.env.APP_DB, {
		listingId: listing.listingId,
	})
	let zeroCredits = false
	let delivered = false
	for (const fork of forks) {
		if (fork.forkerUserId !== input.follow.followerOrgId) continue
		if (fork.originCommit === listing.current.pinnedCommit) continue
		const result = await deliverCommunityForkUpstreamUpdatedAlias({
			env: input.env,
			alias: {
				eventId: input.eventId,
				listing: projection,
				fork,
				previous: listing.previous,
				current: listing.current,
				publishedAt: input.published.publishedAt,
			},
		})
		switch (result) {
			case 'zero_credits':
				zeroCredits = true
				break
			case 'delivered':
				delivered = true
				break
			case 'none':
			case 'failed':
				break
			default: {
				const exhaustive: never = result
				throw new Error(`Unhandled alias result: ${String(exhaustive)}`)
			}
		}
	}
	if (zeroCredits) return 'zero_credits'
	return delivered ? 'delivered' : 'none'
}

async function loadListingProjection(env: Env, listingId: string) {
	const loaded = await getActiveCommunityListingWithPublisherUsername(
		env.APP_DB,
		{ listingId },
	)
	if (!loaded) return null
	const publisherUsername =
		loaded.publisherUsername ?? parseListingOwnerUsername(loaded.listing.name)
	const kodyId = loaded.listing.kodyId
	if (!publisherUsername || !kodyId) return null
	const description = loaded.listing.description.trim()
	return {
		id: loaded.listing.id,
		name: loaded.listing.name,
		kodyId,
		description: description.length > 0 ? description : null,
		publisherUsername,
		publishedAt: loaded.listing.publishedAt,
		publicUrl: `${getAppBaseUrl({ env })}${getCommunityPackageHref({
			username: publisherUsername,
			kodyId,
		})}`,
	}
}

async function invokeFollowTopic(input: {
	env: Env
	follow: FollowRecord
	nowIso: string
	topic: string
	payload: object
	hooks?: FollowDeliveryHooks
	idempotencyKey: (packageId: string) => string
}): Promise<'delivered' | 'zero_credits' | 'none' | 'failed'> {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const payload = input.payload as Record<string, unknown>
	const invoke = input.hooks?.invoke ?? invokePackageSubscription
	let subscriptions: Array<LoadedPackageSubscription> = []
	try {
		if (input.hooks?.loadSubscriptions) {
			subscriptions = await input.hooks.loadSubscriptions({
				env: input.env,
				userId: input.follow.followerOrgId,
				topic: input.topic,
				payload,
			})
		} else {
			const loaded = await loadMatchingPackageSubscriptions({
				env: input.env,
				baseUrl,
				userId: input.follow.followerOrgId,
				topic: input.topic,
			})
			subscriptions = loaded.subscriptions.filter((entry) =>
				packageEventFiltersMatchPayload({
					filters: entry.subscription.filters,
					payload,
				}),
			)
		}
	} catch (error) {
		console.error('follow-subscription-discovery-failed', {
			followId: input.follow.id,
			topic: input.topic,
			error,
		})
		return 'failed'
	}
	let delivered = false
	let zeroCredits = false
	for (const { savedPackage } of subscriptions) {
		try {
			const response = await invoke({
				env: input.env,
				baseUrl,
				savedPackage,
				topic: input.topic,
				params: payload,
				idempotencyKey: input.idempotencyKey(savedPackage.id),
				source: 'follow',
				request: { kind: 'platform-event', sourceId: 'follow' },
				actorTokenId: followSubscriptionActorTokenId,
			})
			if (response.status === 429) {
				zeroCredits = true
				continue
			}
			delivered = true
		} catch (error) {
			console.error('follow-subscription-invoke-failed', {
				followId: input.follow.id,
				packageId: savedPackage.id,
				topic: input.topic,
				error,
			})
		}
	}
	if (zeroCredits) {
		await markFollowDeliverySkip(input.env.APP_DB, {
			id: input.follow.id,
			reason: followZeroCreditsSkipReason,
			skippedAt: input.nowIso,
		})
		return 'zero_credits'
	}
	return delivered ? 'delivered' : 'none'
}
