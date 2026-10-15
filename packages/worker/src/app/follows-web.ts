import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	followAccessFromPermissions,
	loadFollowTargetPermissions,
} from '#worker/follow/access.ts'
import {
	deleteFollowForOrg,
	getFollowByTarget,
	getFollowForOrg,
	listFollowsByFollower,
} from '#worker/follow/repo.ts'
import {
	addFollow,
	FollowNotFoundError,
	FollowRateLimitError,
	FollowTargetNotFoundError,
	removeFollow,
	resolveFollowTarget,
} from '#worker/follow/service.ts'
import {
	followRecordEvents,
	isFollowTargetKind,
	type FollowRecord,
	type FollowView,
} from '#worker/follow/types.ts'
import { listOrgsForPerson } from '#worker/orgs/repo.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getCommunityPackageHrefFromName } from '#universal/community-links.ts'
import {
	followEventsForKind,
	followPausedDeleteAt,
	isFollowEvent,
	type FollowSummary,
	type FollowTargetKindName,
	type OrgFollowRow,
	type OrgFollowsLoaderData,
	type OrgFollowsPostBody,
	type OrgFollowsPostPayload,
	type PackageFollowStatePayload,
} from '#universal/follows.ts'

function summaryFromRecord(record: FollowRecord): FollowSummary {
	return {
		status: record.status,
		events: followRecordEvents(record),
		pausedAt: record.pausedAt,
		pausedReason: record.pausedReason,
		lastDeliverySkipReason: record.lastDeliverySkipReason,
	}
}

function summaryFromView(view: FollowView): FollowSummary {
	return {
		status: view.status,
		events: view.events,
		pausedAt: view.paused_at,
		pausedReason: view.paused_reason,
		lastDeliverySkipReason: view.last_delivery_skip_reason,
	}
}

/**
 * Follow control data for one package or plain repo page. Null when the
 * viewer cannot follow it, which the caller reports the same as missing.
 */
export async function loadPackageFollowState(input: {
	env: Env
	user: AuthenticatedAppUser
	username: string
	kodyId: string
	kind: FollowTargetKindName | undefined
}): Promise<PackageFollowStatePayload | null> {
	const target = await resolveFollowTarget(input.env.APP_DB, {
		name: `@${input.username}/${input.kodyId}`,
		kind: input.kind,
	})
	if (!target) return null
	const personId = input.user.mcpUser.userId
	const access = await loadFollowTargetPermissions({
		env: input.env,
		creatorUserId: personId,
		ownerId: target.ownerId,
	})
	const decision = followAccessFromPermissions({
		targetKind: target.kind,
		isPrivate: target.isPrivate,
		access,
		packageId: target.kind === 'package' ? target.id : null,
		ownerId: target.ownerId,
	})
	if (!decision.canCreate) return null
	const personalOrgId = personalOrgIdForPerson(input.user.mcpUser)
	const orgs = (await listOrgsForPerson(input.env.APP_DB, personId)).filter(
		(org) => org.role !== null,
	)
	const workspaces = await Promise.all(
		orgs.map(async (org) => {
			const follow = await getFollowByTarget(input.env.APP_DB, {
				followerOrgId: org.id,
				targetKind: target.kind,
				targetId: target.id,
			})
			return {
				slug: org.slug,
				displayName: org.display_name,
				personal: org.id === personalOrgId,
				follow: follow ? summaryFromRecord(follow) : null,
			}
		}),
	)
	workspaces.sort((left, right) =>
		left.personal === right.personal
			? left.slug.localeCompare(right.slug)
			: left.personal
				? -1
				: 1,
	)
	return {
		ok: true,
		target: { name: target.name, kind: target.kind },
		availableEvents: followEventsForKind(target.kind),
		canPush: decision.canPush,
		workspaces,
	}
}

function orgFollowRow(record: FollowRecord): OrgFollowRow {
	return {
		...summaryFromRecord(record),
		id: record.id,
		name: record.targetName,
		kind: record.targetKind,
		href: getCommunityPackageHrefFromName(record.targetName),
		availableEvents: followEventsForKind(record.targetKind),
		createdAt: record.createdAt,
		deleteAt:
			record.status === 'paused' ? followPausedDeleteAt(record.pausedAt) : null,
		lastDeliverySkipAt: record.lastDeliverySkipAt,
	}
}

export async function loadOrgFollowsData(input: {
	env: Env
	org: { id: string; slug: string }
}): Promise<OrgFollowsLoaderData> {
	const follows = await listFollowsByFollower(input.env.APP_DB, input.org.id)
	return {
		ok: true,
		orgSlug: input.org.slug,
		follows: follows.map(orgFollowRow),
	}
}

export function parseOrgFollowsPostBody(
	body: unknown,
): OrgFollowsPostBody | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const kind =
		typeof record['kind'] === 'string' && isFollowTargetKind(record['kind'])
			? record['kind']
			: null
	const name = typeof record['name'] === 'string' ? record['name'].trim() : ''
	switch (record['intent']) {
		case 'follow': {
			if (!name || !kind) return null
			const events = record['events']
			if (events === undefined) return { intent: 'follow', name, kind }
			if (!Array.isArray(events) || !events.every(isFollowEvent)) return null
			return { intent: 'follow', name, kind, events }
		}
		case 'unfollow': {
			const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
			if (id) return { intent: 'unfollow', id }
			if (!name || !kind) return null
			return { intent: 'unfollow', name, kind }
		}
		default:
			return null
	}
}

function postError(
	code: Extract<OrgFollowsPostPayload, { ok: false }>['code'],
	error: string,
) {
	return { ok: false as const, code, error }
}

export function orgFollowsPostStatus(payload: OrgFollowsPostPayload) {
	if (payload.ok) return 200
	switch (payload.code) {
		case 'invalid':
			return 400
		case 'unauthorized':
			return 401
		case 'not_found':
			return 404
		case 'rate_limited':
			return 429
		default: {
			const exhaustive: never = payload.code
			throw new Error(`Unhandled follow error code: ${String(exhaustive)}`)
		}
	}
}

/** Follow, change events, or unfollow for the org in the request URL. */
export async function applyOrgFollowsPost(input: {
	env: Env
	user: AuthenticatedAppUser
	org: { id: string }
	body: OrgFollowsPostBody
}): Promise<OrgFollowsPostPayload> {
	const { body } = input
	try {
		switch (body.intent) {
			case 'follow': {
				const follow = await addFollow({
					env: input.env,
					followerOrgId: input.org.id,
					creatorUserId: input.user.mcpUser.userId,
					name: body.name,
					kind: body.kind,
					events: body.events,
				})
				return {
					ok: true,
					intent: 'follow',
					name: follow.name,
					kind: follow.kind,
					follow: summaryFromView(follow),
				}
			}
			case 'unfollow': {
				if ('id' in body) {
					const record = await getFollowForOrg(input.env.APP_DB, {
						followerOrgId: input.org.id,
						id: body.id,
					})
					if (
						!record ||
						!(await deleteFollowForOrg(input.env.APP_DB, {
							followerOrgId: input.org.id,
							id: body.id,
						}))
					) {
						return postError('not_found', 'This follow is already gone.')
					}
					return {
						ok: true,
						intent: 'unfollow',
						name: record.targetName,
						kind: record.targetKind,
						follow: null,
					}
				}
				const { removed } = await removeFollow({
					env: input.env,
					followerOrgId: input.org.id,
					name: body.name,
					kind: body.kind,
				})
				return {
					ok: true,
					intent: 'unfollow',
					name: removed.name,
					kind: removed.kind,
					follow: null,
				}
			}
			default: {
				const exhaustive: never = body
				throw new Error(`Unhandled follow intent: ${String(exhaustive)}`)
			}
		}
	} catch (error) {
		if (error instanceof FollowRateLimitError) {
			return postError('rate_limited', error.message)
		}
		if (
			error instanceof FollowNotFoundError ||
			error instanceof FollowTargetNotFoundError
		) {
			return postError('not_found', error.message)
		}
		if (error instanceof McpCallerError) {
			return postError('invalid', error.message)
		}
		throw error
	}
}
