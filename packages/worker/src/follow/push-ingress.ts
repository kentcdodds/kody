import { type CloudflareArtifactsRepoEvent } from '#worker/repo/artifacts-events.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { mergeFollowPushWindow, type FollowPushIngress } from './coalesce.ts'
import { deliverFollowRecords } from './deliver.ts'
import {
	getFollowPushPending,
	hasAppDb,
	listActiveFollowsByTarget,
	upsertFollowPushPending,
} from './repo.ts'
import { type FollowPushCommit, type FollowTargetKind } from './types.ts'

/**
 * Record a default-branch push into the target's five-minute window.
 * No follows means no row. An expired window is flushed before the new
 * push replaces it; if that flush fails the new commits stay on the old
 * row so the maintenance lane can retry.
 */
export async function recordFollowDefaultBranchPush(input: {
	env: Env
	source: EntitySourceRow
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.pushed' }
	>
}): Promise<void> {
	if (!hasAppDb(input.env.APP_DB)) return
	const targetKind = followTargetKindForEntity(input.source.entity_kind)
	if (!targetKind) return
	const follows = await listActiveFollowsByTarget(input.env.APP_DB, {
		targetKind,
		targetId: input.source.entity_id,
	})
	if (follows.length === 0) return
	const incoming = ingressFromEvent(input.event)
	const existing = await getFollowPushPending(input.env.APP_DB, {
		targetKind,
		targetId: input.source.entity_id,
	})
	const merged = mergeFollowPushWindow({
		targetKind,
		targetId: input.source.entity_id,
		existing,
		incoming,
		now: new Date(incoming.at),
	})
	switch (merged.action) {
		case 'unchanged':
			return
		case 'merge':
			await upsertFollowPushPending(input.env.APP_DB, merged.pending)
			return
		case 'replace': {
			const flushed = await flushPendingWindow({
				env: input.env,
				pending: merged.expired,
			})
			if (!flushed) {
				const kept = mergeFollowPushWindow({
					targetKind,
					targetId: input.source.entity_id,
					existing: merged.expired,
					incoming,
					now: new Date(merged.expired.windowStartedAt),
				})
				await upsertFollowPushPending(input.env.APP_DB, kept.pending)
				return
			}
			await upsertFollowPushPending(input.env.APP_DB, merged.pending)
			return
		}
		default: {
			const exhaustive: never = merged
			throw new Error(`Unhandled follow push merge: ${String(exhaustive)}`)
		}
	}
}

export async function flushPendingWindow(input: {
	env: Env
	pending: {
		targetKind: FollowTargetKind
		targetId: string
		windowStartedAt: string
		beforeCommit: string | null
		afterCommit: string | null
		ref: string
		commits: Array<FollowPushCommit>
		totalCommitsCount: number
		updatedAt: string
	}
}): Promise<boolean> {
	try {
		const follows = await listActiveFollowsByTarget(input.env.APP_DB, {
			targetKind: input.pending.targetKind,
			targetId: input.pending.targetId,
		})
		await deliverFollowRecords({
			env: input.env,
			follows,
			now: new Date(),
			pushed: input.pending,
		})
		return true
	} catch (error) {
		console.error('follow-push-flush-failed', input.pending.targetId, error)
		return false
	}
}

function followTargetKindForEntity(
	kind: EntitySourceRow['entity_kind'],
): FollowTargetKind | null {
	switch (kind) {
		case 'package':
		case 'repo':
			return kind
		default: {
			const exhaustive: never = kind
			throw new Error(`Unsupported entity kind: ${exhaustive}`)
		}
	}
}

function ingressFromEvent(
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.pushed' }
	>,
): FollowPushIngress {
	return {
		before: event.payload.before,
		after: event.payload.after,
		ref: event.payload.ref,
		totalCommitsCount: event.payload.totalCommitsCount,
		at: event.metadata.eventTimestamp,
		commits: event.payload.commits.map((commit) => ({
			id: commit.id,
			message: commit.message,
			message_truncated: commit.messageTruncated,
			timestamp: commit.timestamp,
			author: commit.author,
			committer: commit.committer,
			parents: commit.parents,
		})),
	}
}
