import { followPushCommitsTruncated } from './coalesce.ts'
import {
	followPublishedTopic,
	followPushedTopic,
	type FollowPushPending,
	type FollowTargetSnapshot,
} from './types.ts'

export type FollowPublishedEvent = {
	event: typeof followPublishedTopic
	event_id: string
	target: { kind: 'package'; name: string }
	previous_commit: string | null
	published_commit: string
	published_at: string
}

export type FollowPushedEvent = {
	event: typeof followPushedTopic
	event_id: string
	target: { kind: FollowTargetSnapshot['kind']; name: string }
	push: {
		ref: string
		before: string | null
		after: string | null
		commits: FollowPushPending['commits']
		total_commits_count: number
		commits_truncated: boolean
	}
	window_started_at: string
}

/** Opaque id for the payload. Internal ids stay in delivery idempotency keys. */
export function followPublishedEventId() {
	return crypto.randomUUID()
}

/** Opaque id for the payload. Internal ids stay in delivery idempotency keys. */
export function followPushedEventId() {
	return crypto.randomUUID()
}

export function buildFollowPublishedEvent(input: {
	eventId: string
	targetName: string
	previousCommit: string | null
	publishedCommit: string
	publishedAt: string
}): FollowPublishedEvent {
	return {
		event: followPublishedTopic,
		event_id: input.eventId,
		target: { kind: 'package', name: input.targetName },
		previous_commit: input.previousCommit,
		published_commit: input.publishedCommit,
		published_at: input.publishedAt,
	}
}

export function buildFollowPushedEvent(input: {
	eventId: string
	target: FollowTargetSnapshot
	pending: FollowPushPending
}): FollowPushedEvent {
	return {
		event: followPushedTopic,
		event_id: input.eventId,
		target: { kind: input.target.kind, name: input.target.name },
		push: {
			ref: input.pending.ref,
			before: input.pending.beforeCommit,
			after: input.pending.afterCommit,
			commits: input.pending.commits,
			total_commits_count: input.pending.totalCommitsCount,
			commits_truncated: followPushCommitsTruncated(input.pending),
		},
		window_started_at: input.pending.windowStartedAt,
	}
}
