/**
 * Shareable org membership invite links. Token plaintext is shown once at
 * create; only the SHA-256 hash is stored. Links never grant Owner.
 */
import { toHex } from '@kody-internal/shared/hex.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { isOrgActive } from '#worker/orgs/repo.ts'
import { addOrgMember } from './access-writes.ts'
import { recordOrgAuditEvent, type OrgAuditWriter } from './org-audit.ts'
import { syncSeatsAfterMembershipChange } from './seat-sync-after-membership.ts'

export type InviteLinkRole = 'member' | 'billing'

const inviteLinkRoles = ['member', 'billing'] as const

export function isInviteLinkRole(value: unknown): value is InviteLinkRole {
	return (
		typeof value === 'string' &&
		(inviteLinkRoles as ReadonlyArray<string>).includes(value)
	)
}

export type StoredInviteLink = {
	id: string
	orgId: string
	tokenHash: string
	role: InviteLinkRole
	allowedEmailDomains: Array<string>
	maxUses: number | null
	useCount: number
	status: 'active' | 'revoked'
	createdByUserId: string
	expiresAt: string
	createdAt: string
	revokedAt: string | null
}

export type ListedInviteLink = {
	id: string
	role: InviteLinkRole
	allowedEmailDomains: Array<string>
	maxUses: number | null
	useCount: number
	expiresAt: string
	createdAt: string
	createdByUserId: string
	createdByUsername: string | null
	createdByDisplayName: string | null
}

export type InviteLinkRedeemBlockReason =
	| 'invalid'
	| 'revoked'
	| 'expired'
	| 'exhausted'
	| 'org_inactive'
	| 'personal_org'
	| 'domain'
	| 'unverified_email'
	| 'inviter_gone'

type InviteLinkRow = {
	id: string
	org_id: string
	token_hash: string
	role: string
	allowed_email_domains_json: string | null
	max_uses: number | null
	use_count: number
	status: string
	created_by_user_id: string
	expires_at: string
	created_at: string
	revoked_at: string | null
}

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export function generateInviteLinkToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

export async function hashInviteLinkToken(token: string) {
	return await sha256Hex(token.trim())
}

function parseAllowedDomains(value: string | null): Array<string> {
	if (!value) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(value) as unknown
	} catch {
		throw new Error('Invite link domain rules are invalid.')
	}
	if (!Array.isArray(parsed)) {
		throw new Error('Invite link domain rules are invalid.')
	}
	const domains: Array<string> = []
	for (const entry of parsed) {
		if (typeof entry !== 'string') {
			throw new Error('Invite link domain rules are invalid.')
		}
		const trimmed = entry.trim().toLowerCase()
		if (trimmed.length > 0) domains.push(trimmed)
	}
	return domains
}

function readAllowedDomainsOrBlock(
	value: string | null,
): { ok: true; domains: Array<string> } | { ok: false } {
	try {
		return { ok: true, domains: parseAllowedDomains(value) }
	} catch {
		return { ok: false }
	}
}

function normalizeDomainList(
	domains: ReadonlyArray<string> | null | undefined,
): Array<string> {
	if (!domains || domains.length === 0) return []
	const unique = new Set<string>()
	for (const raw of domains) {
		const trimmed = raw.trim().toLowerCase().replace(/^@/, '')
		if (!trimmed) continue
		if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(trimmed)) {
			throw new Error(`Invalid email domain: ${raw}`)
		}
		unique.add(trimmed)
	}
	return [...unique].sort()
}

function rowToStored(row: InviteLinkRow): StoredInviteLink {
	if (row.role !== 'member' && row.role !== 'billing') {
		throw new Error(`Invite link ${row.id} has role ${row.role}.`)
	}
	if (row.status !== 'active' && row.status !== 'revoked') {
		throw new Error(`Invite link ${row.id} has status ${row.status}.`)
	}
	const domains = readAllowedDomainsOrBlock(row.allowed_email_domains_json)
	return {
		id: row.id,
		orgId: row.org_id,
		tokenHash: row.token_hash,
		role: row.role,
		allowedEmailDomains: domains.ok ? domains.domains : [],
		maxUses: row.max_uses,
		useCount: row.use_count,
		status: row.status,
		createdByUserId: row.created_by_user_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
	}
}

function rowDomainsBlocked(row: InviteLinkRow) {
	return !readAllowedDomainsOrBlock(row.allowed_email_domains_json).ok
}

export type InviteLinkAvailabilityReason = Extract<
	InviteLinkRedeemBlockReason,
	'revoked' | 'expired' | 'exhausted'
>

export function inviteLinkIsRedeemable(
	link: StoredInviteLink,
	nowIso = new Date().toISOString(),
): InviteLinkAvailabilityReason | null {
	if (link.status === 'revoked') return 'revoked'
	if (link.expiresAt <= nowIso) return 'expired'
	if (link.maxUses != null && link.useCount >= link.maxUses) return 'exhausted'
	return null
}

export function emailMatchesInviteLinkDomains(
	email: string,
	domains: ReadonlyArray<string>,
): boolean {
	if (domains.length === 0) return true
	const normalized = normalizeEmailAddress(email)
	if (!normalized) return false
	const at = normalized.lastIndexOf('@')
	if (at < 0) return false
	const domain = normalized.slice(at + 1)
	return domains.includes(domain)
}

export async function createOrgInviteLink(input: {
	db: D1Database
	orgId: string
	role: InviteLinkRole
	createdByUserId: string
	tokenHash: string
	allowedEmailDomains?: ReadonlyArray<string> | null
	maxUses?: number | null
	expiresAt?: string
	audit: OrgAuditWriter
}) {
	if (await isPersonalOrg(input.db, input.orgId)) {
		throw new Error(
			'Membership for your personal organization is managed with your account. Create a team organization to invite people.',
		)
	}
	if (!(await isOrgActive(input.db, input.orgId))) {
		throw new Error('This organization is not active.')
	}
	const domains = normalizeDomainList(input.allowedEmailDomains)
	const maxUses =
		input.maxUses == null || input.maxUses === undefined
			? null
			: Math.floor(input.maxUses)
	if (maxUses != null && maxUses < 1) {
		throw new Error('Max uses must be at least 1 when set.')
	}
	const id = crypto.randomUUID()
	const now = new Date().toISOString()
	const expiresAt =
		input.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString()
	if (expiresAt <= now) {
		throw new Error('Expiry must be in the future.')
	}
	await input.db
		.prepare(
			`INSERT INTO org_invite_links (
				id, org_id, token_hash, role, allowed_email_domains_json,
				max_uses, use_count, status, created_by_user_id, expires_at,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
		)
		.bind(
			id,
			input.orgId,
			input.tokenHash,
			input.role,
			domains.length > 0 ? JSON.stringify(domains) : null,
			maxUses,
			input.createdByUserId,
			expiresAt,
			now,
		)
		.run()
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'invite_link.created',
		resourceType: 'invite_link',
		resourceId: id,
		details: {
			role: input.role,
			maxUses,
			expiresAt,
			allowedEmailDomains: domains,
		},
	})
	return { id, expiresAt, allowedEmailDomains: domains, maxUses }
}

export async function getInviteLinkByTokenHash(
	db: D1Database,
	tokenHash: string,
): Promise<StoredInviteLink | null> {
	const row = await db
		.prepare(
			`SELECT id, org_id, token_hash, role, allowed_email_domains_json,
			        max_uses, use_count, status, created_by_user_id, expires_at,
			        created_at, revoked_at
			 FROM org_invite_links
			 WHERE token_hash = ?`,
		)
		.bind(tokenHash)
		.first<InviteLinkRow>()
	if (!row) return null
	if (rowDomainsBlocked(row)) return null
	return rowToStored(row)
}

export async function getInviteLinkById(input: {
	db: D1Database
	orgId: string
	linkId: string
}): Promise<StoredInviteLink | null> {
	const row = await input.db
		.prepare(
			`SELECT id, org_id, token_hash, role, allowed_email_domains_json,
			        max_uses, use_count, status, created_by_user_id, expires_at,
			        created_at, revoked_at
			 FROM org_invite_links
			 WHERE id = ? AND org_id = ?`,
		)
		.bind(input.linkId, input.orgId)
		.first<InviteLinkRow>()
	return row ? rowToStored(row) : null
}

/**
 * Active links that are still within expiry and under max uses. Revoked,
 * expired, and exhausted links drop off the Members page list.
 */
export async function listActiveOrgInviteLinks(
	db: D1Database,
	orgId: string,
	nowIso = new Date().toISOString(),
): Promise<Array<ListedInviteLink>> {
	const rows = await db
		.prepare(
			`SELECT l.id AS id,
			        l.role AS role,
			        l.allowed_email_domains_json AS allowed_email_domains_json,
			        l.max_uses AS max_uses,
			        l.use_count AS use_count,
			        l.expires_at AS expires_at,
			        l.created_at AS created_at,
			        l.created_by_user_id AS created_by_user_id,
			        u.username AS created_by_username,
			        u.display_name AS created_by_display_name
			 FROM org_invite_links l
			 LEFT JOIN users u
			   ON u.stable_user_id = l.created_by_user_id
			  AND u.deleted_at IS NULL
			 WHERE l.org_id = ?
			   AND l.status = 'active'
			   AND l.expires_at > ?
			   AND (l.max_uses IS NULL OR l.use_count < l.max_uses)
			 ORDER BY l.created_at DESC`,
		)
		.bind(orgId, nowIso)
		.all<{
			id: string
			role: string
			allowed_email_domains_json: string | null
			max_uses: number | null
			use_count: number
			expires_at: string
			created_at: string
			created_by_user_id: string
			created_by_username: string | null
			created_by_display_name: string | null
		}>()
	return (rows.results ?? []).flatMap((row) => {
		if (row.role !== 'member' && row.role !== 'billing') return []
		const domains = readAllowedDomainsOrBlock(row.allowed_email_domains_json)
		if (!domains.ok) return []
		return [
			{
				id: row.id,
				role: row.role,
				allowedEmailDomains: domains.domains,
				maxUses: row.max_uses,
				useCount: row.use_count,
				expiresAt: row.expires_at,
				createdAt: row.created_at,
				createdByUserId: row.created_by_user_id,
				createdByUsername: row.created_by_username,
				createdByDisplayName: row.created_by_display_name,
			},
		]
	})
}

export async function revokeOrgInviteLink(input: {
	db: D1Database
	orgId: string
	linkId: string
	audit: OrgAuditWriter
}) {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE org_invite_links
			 SET status = 'revoked', revoked_at = ?
			 WHERE id = ? AND org_id = ? AND status = 'active'`,
		)
		.bind(now, input.linkId, input.orgId)
		.run()
	if ((result.meta?.changes ?? 0) === 0) {
		throw new Error('That invite link could not be revoked.')
	}
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'invite_link.revoked',
		resourceType: 'invite_link',
		resourceId: input.linkId,
	})
}

async function claimInviteLinkUse(input: {
	db: D1Database
	linkId: string
	userId: string
	nowIso: string
}): Promise<'claimed' | 'already' | 'unavailable'> {
	const existing = await input.db
		.prepare(
			`SELECT 1 AS ok FROM org_invite_link_redemptions
			 WHERE link_id = ? AND user_id = ?`,
		)
		.bind(input.linkId, input.userId)
		.first<{ ok: number }>()
	if (existing) return 'already'

	const insert = await input.db
		.prepare(
			`INSERT OR IGNORE INTO org_invite_link_redemptions (
				link_id, user_id, created_at
			) VALUES (?, ?, ?)`,
		)
		.bind(input.linkId, input.userId, input.nowIso)
		.run()
	if ((insert.meta?.changes ?? 0) === 0) return 'already'

	const bumped = await input.db
		.prepare(
			`UPDATE org_invite_links
			 SET use_count = use_count + 1
			 WHERE id = ?
			   AND status = 'active'
			   AND expires_at > ?
			   AND (max_uses IS NULL OR use_count < max_uses)`,
		)
		.bind(input.linkId, input.nowIso)
		.run()
	if ((bumped.meta?.changes ?? 0) === 0) {
		await input.db
			.prepare(
				`DELETE FROM org_invite_link_redemptions
				 WHERE link_id = ? AND user_id = ?`,
			)
			.bind(input.linkId, input.userId)
			.run()
		return 'unavailable'
	}
	return 'claimed'
}

async function assertInviteLinkCreatorStillValid(
	db: D1Database,
	link: StoredInviteLink,
) {
	const creator = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(link.orgId, link.createdByUserId)
		.first<{ role: string }>()
	if (!creator) {
		throw new Error('inviter_gone')
	}
}

function seatRole(role: OrgRole) {
	return role === 'owner' || role === 'member'
}

export type RedeemInviteLinkResult =
	| { ok: true; alreadyMember: boolean; role: InviteLinkRole; orgId: string }
	| { ok: false; reason: InviteLinkRedeemBlockReason; error: string }

export async function redeemOrgInviteLink(input: {
	db: D1Database
	env: Env
	link: StoredInviteLink
	user: {
		userId: string
		email: string
		emailVerified: boolean
	}
	audit: OrgAuditWriter
}): Promise<RedeemInviteLinkResult> {
	const nowIso = new Date().toISOString()
	const block = inviteLinkIsRedeemable(input.link, nowIso)
	if (block) {
		return {
			ok: false,
			reason: block,
			error: inviteLinkBlockMessage(block),
		}
	}
	if (await isPersonalOrg(input.db, input.link.orgId)) {
		return {
			ok: false,
			reason: 'personal_org',
			error: inviteLinkBlockMessage('personal_org'),
		}
	}
	if (!(await isOrgActive(input.db, input.link.orgId))) {
		return {
			ok: false,
			reason: 'org_inactive',
			error: inviteLinkBlockMessage('org_inactive'),
		}
	}
	try {
		await assertInviteLinkCreatorStillValid(input.db, input.link)
	} catch {
		return {
			ok: false,
			reason: 'inviter_gone',
			error: inviteLinkBlockMessage('inviter_gone'),
		}
	}
	if (input.link.allowedEmailDomains.length > 0) {
		if (!input.user.emailVerified) {
			return {
				ok: false,
				reason: 'unverified_email',
				error: inviteLinkBlockMessage('unverified_email'),
			}
		}
		if (
			!emailMatchesInviteLinkDomains(
				input.user.email,
				input.link.allowedEmailDomains,
			)
		) {
			return {
				ok: false,
				reason: 'domain',
				error: inviteLinkBlockMessage('domain'),
			}
		}
	}

	const existing = await input.db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.link.orgId, input.user.userId)
		.first<{ role: string }>()
	if (existing) {
		return {
			ok: true,
			alreadyMember: true,
			role: input.link.role,
			orgId: input.link.orgId,
		}
	}

	const claimed = await claimInviteLinkUse({
		db: input.db,
		linkId: input.link.id,
		userId: input.user.userId,
		nowIso,
	})
	if (claimed === 'already') {
		return {
			ok: true,
			alreadyMember: true,
			role: input.link.role,
			orgId: input.link.orgId,
		}
	}
	if (claimed === 'unavailable') {
		const refreshed = await getInviteLinkByTokenHash(
			input.db,
			input.link.tokenHash,
		)
		const reason: InviteLinkRedeemBlockReason =
			refreshed == null
				? 'invalid'
				: (inviteLinkIsRedeemable(refreshed, nowIso) ?? 'exhausted')
		return {
			ok: false,
			reason,
			error: inviteLinkBlockMessage(reason),
		}
	}

	await addOrgMember({
		db: input.db,
		orgId: input.link.orgId,
		userId: input.user.userId,
		role: input.link.role,
		invitedByUserId: input.link.createdByUserId,
		audit: input.audit,
	})
	if (seatRole(input.link.role)) {
		await syncSeatsAfterMembershipChange({
			db: input.db,
			env: input.env,
			orgId: input.link.orgId,
		})
	}
	await recordOrgAuditEvent(input.audit, {
		orgId: input.link.orgId,
		action: 'invite_link.joined',
		resourceType: 'invite_link',
		resourceId: input.link.id,
		targetUserId: input.user.userId,
		details: {
			role: input.link.role,
			linkId: input.link.id,
		},
	})
	return {
		ok: true,
		alreadyMember: false,
		role: input.link.role,
		orgId: input.link.orgId,
	}
}

export function inviteLinkBlockMessage(
	reason: InviteLinkRedeemBlockReason,
): string {
	switch (reason) {
		case 'invalid':
			return 'This invite link is invalid.'
		case 'revoked':
			return 'This invite link has been revoked.'
		case 'expired':
			return 'This invite link has expired.'
		case 'exhausted':
			return 'This invite link has reached its use limit.'
		case 'org_inactive':
			return 'This organization is no longer active.'
		case 'personal_org':
			return 'Personal organizations do not accept invite links.'
		case 'domain':
			return 'Your verified email domain is not allowed for this invite link.'
		case 'unverified_email':
			return 'Verify your email address before joining with this invite link.'
		case 'inviter_gone':
			return 'This invite link is no longer valid because the creator no longer has access.'
		default: {
			const exhaustive: never = reason
			return exhaustive
		}
	}
}
