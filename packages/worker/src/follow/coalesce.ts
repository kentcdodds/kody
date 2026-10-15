import {
	followPushMaxCommits,
	followPushWindowMs,
	type FollowPushCommit,
	type FollowPushPending,
	type FollowTargetKind,
} from './types.ts'

export type FollowPushIngress = {
	before: string
	after: string
	ref: string
	commits: Array<FollowPushCommit>
	totalCommitsCount: number
	at: string
}

export type FollowPushMerge =
	| { action: 'unchanged'; pending: FollowPushPending }
	| { action: 'merge'; pending: FollowPushPending }
	| {
			action: 'replace'
			expired: FollowPushPending
			pending: FollowPushPending
	  }

function followPushWindowOpen(windowStartedAt: string, now: Date) {
	const started = Date.parse(windowStartedAt)
	if (!Number.isFinite(started)) return false
	return now.getTime() - started < followPushWindowMs
}

/**
 * One pending row per target. Pushes inside the open five-minute window
 * collapse: `before` stays the first parent, `after` moves to the latest
 * tip, and at most {@link followPushMaxCommits} commits are kept (newest).
 * A push after the window expires starts a new row; the caller flushes the
 * expired snapshot first.
 */
export function mergeFollowPushWindow(input: {
	targetKind: FollowTargetKind
	targetId: string
	existing: FollowPushPending | null
	incoming: FollowPushIngress
	now: Date
}): FollowPushMerge {
	const fresh = freshWindow(input)
	if (!input.existing) return { action: 'merge', pending: fresh }
	if (
		input.existing.afterCommit === input.incoming.after &&
		input.existing.ref === input.incoming.ref &&
		followPushWindowOpen(input.existing.windowStartedAt, input.now)
	) {
		return { action: 'unchanged', pending: input.existing }
	}
	if (!followPushWindowOpen(input.existing.windowStartedAt, input.now)) {
		return { action: 'replace', expired: input.existing, pending: fresh }
	}
	const commits = capCommits([
		...input.existing.commits,
		...input.incoming.commits,
	])
	return {
		action: 'merge',
		pending: {
			...input.existing,
			afterCommit: input.incoming.after,
			ref: input.incoming.ref,
			commits,
			totalCommitsCount:
				input.existing.totalCommitsCount + input.incoming.totalCommitsCount,
			updatedAt: input.incoming.at,
		},
	}
}

function freshWindow(input: {
	targetKind: FollowTargetKind
	targetId: string
	incoming: FollowPushIngress
}): FollowPushPending {
	return {
		targetKind: input.targetKind,
		targetId: input.targetId,
		windowStartedAt: input.incoming.at,
		beforeCommit: input.incoming.before,
		afterCommit: input.incoming.after,
		ref: input.incoming.ref,
		commits: capCommits(input.incoming.commits),
		totalCommitsCount: input.incoming.totalCommitsCount,
		updatedAt: input.incoming.at,
	}
}

function capCommits(commits: Array<FollowPushCommit>) {
	if (commits.length <= followPushMaxCommits) return commits
	return commits.slice(commits.length - followPushMaxCommits)
}

export function followPushCommitsTruncated(pending: FollowPushPending) {
	return pending.totalCommitsCount > pending.commits.length
}
