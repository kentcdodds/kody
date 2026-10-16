import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import {
	revokeOAuthGrant,
	type OAuthGrantHelpers,
} from '#worker/oauth-grants.ts'
import { grantHasMetadataOrgId } from '#worker/orgs/oauth-grant.ts'

/**
 * Confirm string required when dryRun is false. Matches the Teams P9 leftover
 * wording so an apply cannot be a one-bit flip of a dry-run call.
 */
export const oauthGrantsLackingOrgIdRevokeConfirm =
	'revoke grants lacking metadata.orgId'

export const oauthGrantsLackingOrgIdScanLimitDefault = 200
export const oauthGrantsLackingOrgIdScanLimitMax = 500

export type OauthGrantLackingOrgIdFailure = {
	/** Grant id only (never tokens). */
	grantId: string
	/** Stable user id from the KV key. */
	userId: string
	clientId: string
	error: string
}

export type OauthGrantsLackingOrgIdByClient = {
	clientId: string
	count: number
}

export type OauthGrantsLackingOrgIdRevokeResult = {
	dryRun: boolean
	/** Grant keys inspected in this page. */
	scanned: number
	/** Of scanned, how many had plaintext metadata.orgId. */
	withOrgId: number
	/** Of scanned, how many lacked plaintext metadata.orgId. */
	lackingOrgId: number
	/** Grants revoked in this page (0 on dry-run). */
	revoked: number
	/** Unique user ids among lackingOrgId grants in this page. */
	usersLackingOrgId: number
	/** Lacking-orgId counts by clientId for this page. */
	byClient: Array<OauthGrantsLackingOrgIdByClient>
	failures: Array<OauthGrantLackingOrgIdFailure>
	nextCursor: string | null
	complete: boolean
}

type GrantKeyParts = {
	userId: string
	grantId: string
}

export function parseOauthGrantKvKey(key: string): GrantKeyParts | null {
	if (!key.startsWith('grant:')) return null
	const rest = key.slice('grant:'.length)
	const separator = rest.indexOf(':')
	if (separator <= 0 || separator === rest.length - 1) return null
	const userId = rest.slice(0, separator)
	const grantId = rest.slice(separator + 1)
	if (!userId || !grantId || grantId.includes(':')) return null
	return { userId, grantId }
}

export function readOauthGrantClientId(value: unknown): string {
	if (typeof value !== 'object' || value === null) return '(unknown)'
	const clientId = (value as { clientId?: unknown }).clientId
	if (typeof clientId !== 'string') return '(unknown)'
	const trimmed = clientId.trim()
	return trimmed.length > 0 ? trimmed : '(unknown)'
}

function compareByClient(
	left: OauthGrantsLackingOrgIdByClient,
	right: OauthGrantsLackingOrgIdByClient,
) {
	if (right.count !== left.count) return right.count - left.count
	return left.clientId.localeCompare(right.clientId)
}

function toByClient(
	counts: ReadonlyMap<string, number>,
): Array<OauthGrantsLackingOrgIdByClient> {
	return [...counts.entries()]
		.map(([clientId, count]) => ({ clientId, count }))
		.sort(compareByClient)
}

/**
 * One paged pass over `OAUTH_KV` `grant:*` keys. Dry-run (default) counts
 * grants lacking plaintext `metadata.orgId`. Apply revokes those grants via
 * the OAuth helpers (tokens + refresh family). Idempotent: a second pass after
 * a complete apply finds zero lacking. Never returns tokens or encrypted props.
 */
export async function runOauthGrantsLackingOrgIdRevoke(input: {
	env: Env
	dryRun: boolean
	cursor?: string | null
	limit?: number
}): Promise<OauthGrantsLackingOrgIdRevokeResult> {
	const kv = input.env.OAUTH_KV
	if (!kv) {
		throw new Error('OAUTH_KV binding is unavailable.')
	}
	const limit = Math.min(
		Math.max(1, input.limit ?? oauthGrantsLackingOrgIdScanLimitDefault),
		oauthGrantsLackingOrgIdScanLimitMax,
	)

	const page = await kv.list({
		prefix: 'grant:',
		limit,
		...(input.cursor ? { cursor: input.cursor } : {}),
	})

	let helpers: OAuthGrantHelpers | undefined
	if (!input.dryRun) {
		helpers = (await resolveOAuthHelpers<OAuthGrantHelpers>(input.env)) as
			| OAuthGrantHelpers
			| undefined
		if (!helpers?.revokeGrant) {
			throw new Error('OAuth grant helpers are unavailable for revoke.')
		}
	}

	let withOrgId = 0
	let lackingOrgId = 0
	let revoked = 0
	const users = new Set<string>()
	const byClientCounts = new Map<string, number>()
	const failures = new Array<OauthGrantLackingOrgIdFailure>()

	for (const key of page.keys) {
		const parts = parseOauthGrantKvKey(key.name)
		if (!parts) continue
		const value = await kv.get(key.name, { type: 'json' })
		if (grantHasMetadataOrgId(value)) {
			withOrgId += 1
			continue
		}
		lackingOrgId += 1
		users.add(parts.userId)
		const clientId = readOauthGrantClientId(value)
		byClientCounts.set(clientId, (byClientCounts.get(clientId) ?? 0) + 1)

		if (input.dryRun || !helpers) continue
		try {
			await revokeOAuthGrant(helpers, parts.grantId, parts.userId)
			revoked += 1
		} catch (error) {
			failures.push({
				grantId: parts.grantId,
				userId: parts.userId,
				clientId,
				error: getErrorMessage(error).slice(0, 200),
			})
		}
	}

	const complete = page.list_complete === true
	const nextCursor =
		complete || !('cursor' in page) || typeof page.cursor !== 'string'
			? null
			: page.cursor

	return {
		dryRun: input.dryRun,
		scanned: page.keys.length,
		withOrgId,
		lackingOrgId,
		revoked,
		usersLackingOrgId: users.size,
		byClient: toByClient(byClientCounts),
		failures,
		nextCursor,
		complete,
	}
}

/**
 * Merge per-page byClient tallies (caller loops until complete).
 */
export function mergeOauthGrantsLackingOrgIdByClient(
	pages: ReadonlyArray<ReadonlyArray<OauthGrantsLackingOrgIdByClient>>,
): Array<OauthGrantsLackingOrgIdByClient> {
	const counts = new Map<string, number>()
	for (const page of pages) {
		for (const row of page) {
			counts.set(row.clientId, (counts.get(row.clientId) ?? 0) + row.count)
		}
	}
	return toByClient(counts)
}
