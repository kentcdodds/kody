import { McpCallerError } from '#mcp/caller-error.ts'
import { checkRateLimit, releaseRateLimit } from '#worker/app/rate-limit.ts'
import { getOrgBySlug } from '#worker/orgs/repo.ts'
import {
	getPackageNameLeaf,
	getPackageNameScope,
	isScopedPackageName,
} from '#worker/package-registry/package-name.ts'
import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import { getUserRepoByName } from '#worker/repo/user-repos.ts'
import {
	followAccessFromPermissions,
	loadFollowTargetPermissions,
} from './access.ts'
import {
	getFollowByTarget,
	insertFollow,
	listFollowsByFollower,
	resumeFollow,
	retargetFollowCreator,
} from './repo.ts'
import {
	followCreateMaxPerHour,
	followCreateWindowSeconds,
	followView,
	type FollowTargetKind,
	type FollowTargetSnapshot,
	type FollowView,
} from './types.ts'

const followCreateRateLimit = {
	maxRequests: followCreateMaxPerHour,
	windowSeconds: followCreateWindowSeconds,
}

function followCreateRateLimitKey(followerOrgId: string) {
	return `follow-create:${followerOrgId}`
}

function followTargetNotFound(name: string) {
	return new McpCallerError(
		`Follow target ${JSON.stringify(name.trim())} was not found.`,
	)
}

export class FollowRateLimitError extends McpCallerError {
	constructor() {
		super(
			`Follow limit reached for this org (${followCreateMaxPerHour} new follows per hour). Try again in about an hour.`,
		)
		this.name = 'FollowRateLimitError'
	}
}

/** Counts one new follow. Deliveries and fork auto-follows do not call this. */
export async function consumeFollowCreateSlot(
	db: D1Database,
	followerOrgId: string,
) {
	const result = await checkRateLimit(
		db,
		followCreateRateLimitKey(followerOrgId),
		followCreateRateLimit,
	)
	if (!result.allowed) throw new FollowRateLimitError()
}

export async function addFollow(input: {
	env: Env
	followerOrgId: string
	creatorUserId: string
	name: string
	kind?: FollowTargetKind
}): Promise<FollowView> {
	const requested = input.name.trim()
	if (!isScopedPackageName(requested)) {
		throw new McpCallerError(
			'Follow target must be an @handle/name, for example "@ada/notes".',
		)
	}
	const target = await resolveFollowTarget(input.env.APP_DB, {
		name: requested,
		kind: input.kind,
	})
	if (!target) throw followTargetNotFound(requested)
	const access = await loadFollowTargetPermissions({
		env: input.env,
		creatorUserId: input.creatorUserId,
		ownerId: target.ownerId,
	})
	const decision = followAccessFromPermissions({
		targetKind: target.kind,
		isPrivate: target.isPrivate,
		access,
		packageId: target.kind === 'package' ? target.id : null,
		ownerId: target.ownerId,
	})
	if (!decision.canCreate) throw followTargetNotFound(requested)

	const existing = await getFollowByTarget(input.env.APP_DB, {
		followerOrgId: input.followerOrgId,
		targetKind: target.kind,
		targetId: target.id,
	})
	const now = new Date().toISOString()
	if (existing) {
		if (existing.status === 'paused') {
			await resumeFollow(input.env.APP_DB, {
				id: existing.id,
				updatedAt: now,
				creatorUserId: input.creatorUserId,
			})
			return followView({
				...existing,
				status: 'active',
				pausedAt: null,
				creatorUserId: input.creatorUserId,
				updatedAt: now,
			})
		}
		// Member deletion anonymizes creator_user_id to deleted-user while the
		// org follow stays active. Retarget so a teammate who re-adds can gate
		// delivery before the next publish pauses a private target.
		if (existing.creatorUserId !== input.creatorUserId) {
			await retargetFollowCreator(input.env.APP_DB, {
				id: existing.id,
				updatedAt: now,
				creatorUserId: input.creatorUserId,
			})
			return followView({
				...existing,
				creatorUserId: input.creatorUserId,
				updatedAt: now,
			})
		}
		return followView(existing)
	}

	await consumeFollowCreateSlot(input.env.APP_DB, input.followerOrgId)
	const id = crypto.randomUUID()
	try {
		await insertFollow(input.env.APP_DB, {
			id,
			followerOrgId: input.followerOrgId,
			creatorUserId: input.creatorUserId,
			targetKind: target.kind,
			targetOwnerId: target.ownerId,
			targetId: target.id,
			targetName: target.name,
			createdAt: now,
		})
	} catch (error) {
		const raced = await getFollowByTarget(input.env.APP_DB, {
			followerOrgId: input.followerOrgId,
			targetKind: target.kind,
			targetId: target.id,
		})
		if (raced) {
			await releaseRateLimit(
				input.env.APP_DB,
				followCreateRateLimitKey(input.followerOrgId),
			).catch(() => undefined)
			return followView(raced)
		}
		throw error
	}
	const created = await getFollowByTarget(input.env.APP_DB, {
		followerOrgId: input.followerOrgId,
		targetKind: target.kind,
		targetId: target.id,
	})
	if (!created) throw followTargetNotFound(requested)
	return followView(created)
}

export async function listFollowsForOrg(input: {
	db: D1Database
	followerOrgId: string
}): Promise<Array<FollowView>> {
	const rows = await listFollowsByFollower(input.db, input.followerOrgId)
	return rows.map(followView)
}

/**
 * `@handle/name` → package or plain repo. When `kind` is omitted and both
 * exist, the package wins. A missing org, package, and repo all return null
 * so the caller can use one not-found error.
 */
export async function resolveFollowTarget(
	db: D1Database,
	input: { name: string; kind?: FollowTargetKind },
): Promise<FollowTargetSnapshot | null> {
	const handle = getPackageNameScope(input.name)
	const leaf = getPackageNameLeaf(input.name).toLowerCase()
	if (!handle || !leaf) return null
	const org = await getOrgBySlug(db, handle)
	if (!org) return null
	const scopedName = `@${org.slug}/${leaf}`
	switch (input.kind) {
		case 'repo':
			return resolveRepo(db, org.id, leaf, scopedName)
		case 'package':
			return resolvePackage(db, org.id, scopedName)
		case undefined:
			return (
				(await resolvePackage(db, org.id, scopedName)) ??
				(await resolveRepo(db, org.id, leaf, scopedName))
			)
		default: {
			const exhaustive: never = input.kind
			throw new Error(`Unsupported follow target kind: ${exhaustive}`)
		}
	}
}

async function resolvePackage(
	db: D1Database,
	ownerId: string,
	scopedName: string,
): Promise<FollowTargetSnapshot | null> {
	const saved = await getSavedPackageByName(db, {
		userId: ownerId,
		name: scopedName,
	})
	if (!saved) return null
	return {
		kind: 'package',
		ownerId: saved.userId,
		id: saved.id,
		name: saved.name,
		isPrivate: saved.isPrivate,
	}
}

async function resolveRepo(
	db: D1Database,
	ownerId: string,
	leaf: string,
	scopedName: string,
): Promise<FollowTargetSnapshot | null> {
	const repo = await getUserRepoByName(db, { userId: ownerId, name: leaf })
	if (!repo) return null
	return {
		kind: 'repo',
		ownerId: repo.userId,
		id: repo.id,
		name: scopedName,
		isPrivate: repo.isPrivate,
	}
}
