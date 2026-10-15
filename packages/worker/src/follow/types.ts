export const followTargetKinds = ['package', 'repo'] as const

export type FollowTargetKind = (typeof followTargetKinds)[number]

export const followStatuses = ['active', 'paused'] as const

export type FollowStatus = (typeof followStatuses)[number]

export const followPublishedTopic = 'follow.published'
export const followPushedTopic = 'follow.pushed'

export const followCreateMaxPerHour = 30
export const followCreateWindowSeconds = 60 * 60
export const followPushWindowMs = 5 * 60 * 1000
export const followPushMaxCommits = 20
export const followPauseRetentionMs = 30 * 24 * 60 * 60 * 1000
export const followZeroCreditsSkipReason = 'zero_credits'

export type FollowPushCommit = {
	id: string
	message: string
	message_truncated: boolean
	timestamp: string
	author: { name: string; email: string }
	committer: { name: string; email: string }
	parents: Array<string>
}

export type FollowRecord = {
	id: string
	followerOrgId: string
	creatorUserId: string
	targetKind: FollowTargetKind
	targetOwnerId: string
	targetId: string
	targetName: string
	status: FollowStatus
	pausedAt: string | null
	lastDeliverySkipReason: string | null
	lastDeliverySkipAt: string | null
	createdAt: string
	updatedAt: string
}

export type FollowView = {
	name: string
	kind: FollowTargetKind
	status: FollowStatus
	created_at: string
	paused_at: string | null
	last_delivery_skip_reason: string | null
}

export type FollowPushPending = {
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

export type FollowTargetSnapshot = {
	kind: FollowTargetKind
	ownerId: string
	id: string
	name: string
	isPrivate: boolean
}

export function followView(record: FollowRecord): FollowView {
	return {
		name: record.targetName,
		kind: record.targetKind,
		status: record.status,
		created_at: record.createdAt,
		paused_at: record.pausedAt,
		last_delivery_skip_reason: record.lastDeliverySkipReason,
	}
}

export function isFollowTargetKind(value: string): value is FollowTargetKind {
	switch (value) {
		case 'package':
		case 'repo':
			return true
		default:
			return false
	}
}
