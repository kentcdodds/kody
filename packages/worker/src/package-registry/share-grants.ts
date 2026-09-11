import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { getUserPlan } from '#worker/entitlements/service.ts'
import {
	findPublicUserIdentityByStableUserId,
	findPublicUserIdentityByUsername,
	type PublicUserIdentity,
} from '#worker/identity/user-lookup.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { type PlanName } from '#universal/plans.ts'
import { type PackageShareGrantLoaderView } from '#universal/package-share.ts'
import { getCommunityPackageHref } from '#worker/community/package-url.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import { getSavedPackageById } from './repo.ts'
import {
	defaultPackageShareRole,
	isPackageShareRole,
	packageShareRoleAllows,
	type PackageSharePermission,
	type PackageShareRole,
} from './share-rbac.ts'
import { type SavedPackageRecord } from './types.ts'

export const packageShareStatuses = [
	'pending',
	'accepted',
	'revoked',
	'left',
] as const

export type PackageShareStatus = (typeof packageShareStatuses)[number]

export const packageShareTrustLevels = ['follow', 'pin'] as const

export type PackageShareTrustLevel = (typeof packageShareTrustLevels)[number]

export const defaultPackageShareTrustLevel: PackageShareTrustLevel = 'pin'

function canPrepareAppDb(db: D1Database | null | undefined): db is D1Database {
	return typeof db?.prepare === 'function'
}

function isMissingShareGrantsTable(error: unknown) {
	const message = getErrorMessage(error)
	return (
		/no such table/i.test(message) && message.includes('package_share_grants')
	)
}

async function queryShareGrantsOrEmpty<T>(
	query: () => Promise<T>,
	empty: T,
): Promise<T> {
	try {
		return await query()
	} catch (error) {
		if (isMissingShareGrantsTable(error)) return empty
		throw error
	}
}

export type PackageShareGrantRow = {
	id: string
	packageId: string
	ownerUserId: string
	inviteeEmail: string | null
	inviteeUsername: string | null
	granteeUserId: string | null
	status: PackageShareStatus
	role: PackageShareRole
	trustLevel: PackageShareTrustLevel | null
	acceptedPublishedCommit: string | null
	invitedAt: string
	acceptedAt: string | null
	revokedAt: string | null
	leftAt: string | null
	lastAcknowledgedAt: string | null
	createdAt: string
	updatedAt: string
}

export type PackageShareGrantView = PackageShareGrantRow & {
	packageName: string
	packageKodyId: string
	ownerUsername: string
	granteeUsername: string | null
	publishedCommit: string | null
	pinAhead: boolean
	approveChangesPath: string | null
}

/**
 * Caller-clearable share-grant denial. Lives in the worker layer so MCP
 * capabilities and import resolvers can throw it without importing `#mcp/*`.
 */
export class PackageShareAccessError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PackageShareAccessError'
	}
}

export class PackageSharePaidRequiredError extends PackageShareAccessError {
	constructor(message: string) {
		super(message)
		this.name = 'PackageSharePaidRequiredError'
	}
}

export class PackageSharePinAheadError extends PackageShareAccessError {
	readonly approveChangesPath: string
	constructor(message: string, approveChangesPath: string) {
		super(message)
		this.name = 'PackageSharePinAheadError'
		this.approveChangesPath = approveChangesPath
	}
}

function nowIso() {
	return new Date().toISOString()
}

function isShareStatus(value: string): value is PackageShareStatus {
	return (packageShareStatuses as ReadonlyArray<string>).includes(value)
}

function isShareTrustLevel(value: string): value is PackageShareTrustLevel {
	return (packageShareTrustLevels as ReadonlyArray<string>).includes(value)
}

function mapGrantRow(row: Record<string, unknown>): PackageShareGrantRow {
	const status = String(row['status'] ?? '')
	const role = String(row['role'] ?? '')
	const trustLevel =
		row['trust_level'] == null ? null : String(row['trust_level'])
	if (!isShareStatus(status)) {
		throw new Error('Stored package share grant status is not a known status.')
	}
	if (!isPackageShareRole(role)) {
		throw new Error('Stored package share grant role is not a known role.')
	}
	if (trustLevel !== null && !isShareTrustLevel(trustLevel)) {
		throw new Error(
			'Stored package share grant trust level is not a known trust level.',
		)
	}
	return {
		id: String(row['id']),
		packageId: String(row['package_id']),
		ownerUserId: String(row['owner_user_id']),
		inviteeEmail:
			row['invitee_email'] == null ? null : String(row['invitee_email']),
		inviteeUsername:
			row['invitee_username'] == null ? null : String(row['invitee_username']),
		granteeUserId:
			row['grantee_user_id'] == null ? null : String(row['grantee_user_id']),
		status,
		role,
		trustLevel,
		acceptedPublishedCommit:
			row['accepted_published_commit'] == null
				? null
				: String(row['accepted_published_commit']),
		invitedAt: String(row['invited_at']),
		acceptedAt: row['accepted_at'] == null ? null : String(row['accepted_at']),
		revokedAt: row['revoked_at'] == null ? null : String(row['revoked_at']),
		leftAt: row['left_at'] == null ? null : String(row['left_at']),
		lastAcknowledgedAt:
			row['last_acknowledged_at'] == null
				? null
				: String(row['last_acknowledged_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

const grantSelectColumns = `id, package_id, owner_user_id, invitee_email, invitee_username,
	grantee_user_id, status, role, trust_level, accepted_published_commit,
	invited_at, accepted_at, revoked_at, left_at, last_acknowledged_at,
	created_at, updated_at`

export function isPaidPlanForPackageShare(plan: PlanName) {
	return plan !== 'free'
}

export async function assertPaidPlanForPackageShare(
	db: D1Database,
	input: { userId: string; email: string | null | undefined; who: string },
) {
	const plan = await getUserPlan(db, {
		userId: input.userId,
		email: input.email,
	})
	if (!isPaidPlanForPackageShare(plan)) {
		throw new PackageSharePaidRequiredError(
			`${input.who} must be on a paid Kody plan to share or use a shared package. Open /pricing, then retry.`,
		)
	}
}

export async function findPersonUserByEmail(
	db: D1Database,
	email: string,
): Promise<PublicUserIdentity | null> {
	const normalized = normalizeEmailAddress(email)
	if (!normalized) return null
	const userRecord = await db
		.prepare(
			`SELECT id, username, email, stable_user_id, account_type
			FROM users
			WHERE email = ?`,
		)
		.bind(normalized)
		.first<{
			id: number
			username: string
			email: string
			stable_user_id: string
			account_type: string | null
		}>()
	if (!userRecord || userRecord.account_type === 'platform') return null
	return {
		userId: userRecord.id,
		username: userRecord.username,
		email: userRecord.email,
		mcpUserId: userRecord.stable_user_id,
	}
}

export function buildPackageShareApproveChangesPath(input: {
	ownerUsername: string
	kodyId: string
}) {
	return `${getCommunityPackageHref({
		username: input.ownerUsername,
		kodyId: input.kodyId,
	})}/approve-changes`
}

export function toPackageShareGrantLoaderView(
	view: PackageShareGrantView,
): PackageShareGrantLoaderView {
	return {
		id: view.id,
		packageId: view.packageId,
		status: view.status,
		role: view.role,
		trustLevel: view.trustLevel,
		pinAhead: view.pinAhead,
		approveChangesPath: view.approveChangesPath,
		packagePath: getCommunityPackageHref({
			username: view.ownerUsername,
			kodyId: view.packageKodyId,
		}),
		packageName: view.packageName,
		packageKodyId: view.packageKodyId,
		ownerUsername: view.ownerUsername,
		inviteeEmail: view.inviteeEmail,
		inviteeUsername: view.inviteeUsername,
		granteeUsername: view.granteeUsername,
		acceptedPublishedCommit: view.acceptedPublishedCommit,
		publishedCommit: view.publishedCommit,
	}
}

export function buildPackageShareAcceptPath(input: {
	ownerUsername: string
	kodyId: string
}) {
	return getCommunityPackageHref({
		username: input.ownerUsername,
		kodyId: input.kodyId,
	})
}

function pinAheadMessage(input: {
	packageName: string
	approveChangesPath: string
}) {
	return `Shared package ${input.packageName} published ahead of the commit you pinned. Approve the changes at ${input.approveChangesPath} before using or importing it.`
}

export async function getPackageShareGrantById(
	db: D1Database,
	grantId: string,
): Promise<PackageShareGrantRow | null> {
	const row = await db
		.prepare(
			`SELECT ${grantSelectColumns}
			FROM package_share_grants
			WHERE id = ?`,
		)
		.bind(grantId)
		.first<Record<string, unknown>>()
	return row ? mapGrantRow(row) : null
}

export async function listPackageShareGrantsByPackageId(
	db: D1Database,
	packageId: string,
): Promise<Array<PackageShareGrantRow>> {
	const rows = await db
		.prepare(
			`SELECT ${grantSelectColumns}
			FROM package_share_grants
			WHERE package_id = ?
			ORDER BY created_at ASC`,
		)
		.bind(packageId)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapGrantRow)
}

export async function listOutboundPackageShareGrants(
	db: D1Database,
	ownerUserId: string,
): Promise<Array<PackageShareGrantRow>> {
	const rows = await db
		.prepare(
			`SELECT ${grantSelectColumns}
			FROM package_share_grants
			WHERE owner_user_id = ?
			ORDER BY updated_at DESC`,
		)
		.bind(ownerUserId)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapGrantRow)
}

export async function listInboundPackageShareGrants(
	db: D1Database,
	input: {
		userId: string
		email?: string | null
		emailVerified?: boolean
	},
): Promise<Array<PackageShareGrantRow>> {
	if (!canPrepareAppDb(db)) return []
	return await queryShareGrantsOrEmpty(async () => {
		const email =
			input.emailVerified === true && input.email
				? normalizeEmailAddress(input.email)
				: null
		const rows = email
			? await db
					.prepare(
						`SELECT ${grantSelectColumns}
					FROM package_share_grants
					WHERE grantee_user_id = ?
						OR (
							invitee_email = ?
							AND status = 'pending'
							AND grantee_user_id IS NULL
						)
					ORDER BY updated_at DESC`,
					)
					.bind(input.userId, email)
					.all<Record<string, unknown>>()
			: await db
					.prepare(
						`SELECT ${grantSelectColumns}
					FROM package_share_grants
					WHERE grantee_user_id = ?
					ORDER BY updated_at DESC`,
					)
					.bind(input.userId)
					.all<Record<string, unknown>>()
		return (rows.results ?? []).map(mapGrantRow)
	}, [])
}

export async function findActivePackageShareGrant(input: {
	db: D1Database
	packageId: string
	granteeUserId?: string | null
	inviteeEmail?: string | null
}): Promise<PackageShareGrantRow | null> {
	if (input.granteeUserId) {
		const byGrantee = await input.db
			.prepare(
				`SELECT ${grantSelectColumns}
				FROM package_share_grants
				WHERE package_id = ?
					AND grantee_user_id = ?
					AND status IN ('pending', 'accepted')
				LIMIT 1`,
			)
			.bind(input.packageId, input.granteeUserId)
			.first<Record<string, unknown>>()
		if (byGrantee) return mapGrantRow(byGrantee)
	}
	const email = input.inviteeEmail
		? normalizeEmailAddress(input.inviteeEmail)
		: null
	if (!email) return null
	const byEmail = await input.db
		.prepare(
			`SELECT ${grantSelectColumns}
			FROM package_share_grants
			WHERE package_id = ?
				AND invitee_email = ?
				AND status = 'pending'
				AND grantee_user_id IS NULL
			LIMIT 1`,
		)
		.bind(input.packageId, email)
		.first<Record<string, unknown>>()
	return byEmail ? mapGrantRow(byEmail) : null
}

export async function findConflictingPackageShareGrant(input: {
	db: D1Database
	packageId: string
	granteeUserId?: string | null
	inviteeEmail?: string | null
}): Promise<PackageShareGrantRow | null> {
	const byGuest = await findActivePackageShareGrant({
		db: input.db,
		packageId: input.packageId,
		granteeUserId: input.granteeUserId,
	})
	if (byGuest) return byGuest
	const email = input.inviteeEmail
		? normalizeEmailAddress(input.inviteeEmail)
		: null
	if (!email) return null
	const byEmail = await input.db
		.prepare(
			`SELECT ${grantSelectColumns}
			FROM package_share_grants
			WHERE package_id = ?
				AND invitee_email = ?
				AND status IN ('pending', 'accepted')
			LIMIT 1`,
		)
		.bind(input.packageId, email)
		.first<Record<string, unknown>>()
	return byEmail ? mapGrantRow(byEmail) : null
}

export async function findAcceptedPackageShareGrant(input: {
	db: D1Database
	packageId: string
	granteeUserId: string
}): Promise<PackageShareGrantRow | null> {
	if (!canPrepareAppDb(input.db)) return null
	return await queryShareGrantsOrEmpty(async () => {
		const row = await input.db
			.prepare(
				`SELECT ${grantSelectColumns}
				FROM package_share_grants
				WHERE package_id = ?
					AND grantee_user_id = ?
					AND status = 'accepted'
				LIMIT 1`,
			)
			.bind(input.packageId, input.granteeUserId)
			.first<Record<string, unknown>>()
		return row ? mapGrantRow(row) : null
	}, null)
}

export async function findAcceptedPackageShareGrantByName(input: {
	db: D1Database
	packageName: string
	granteeUserId: string
}): Promise<{
	grant: PackageShareGrantRow
	savedPackage: SavedPackageRecord
} | null> {
	if (!canPrepareAppDb(input.db)) return null
	return await queryShareGrantsOrEmpty(async () => {
		const row = await input.db
			.prepare(
				`SELECT ${grantSelectColumns}
				FROM package_share_grants
				WHERE package_id IN (
					SELECT id FROM saved_packages WHERE name = ?
				)
					AND grantee_user_id = ?
					AND status = 'accepted'
				LIMIT 1`,
			)
			.bind(input.packageName, input.granteeUserId)
			.first<Record<string, unknown>>()
		if (!row) return null
		const grant = mapGrantRow(row)
		const savedPackage = await getSavedPackageById(input.db, {
			userId: grant.ownerUserId,
			packageId: grant.packageId,
		})
		if (!savedPackage) return null
		return { grant, savedPackage }
	}, null)
}

export async function getPublishedCommitForPackage(
	db: D1Database,
	savedPackage: Pick<SavedPackageRecord, 'sourceId'>,
) {
	const source = await getEntitySourceById(db, savedPackage.sourceId)
	return source?.published_commit ?? null
}

function grantAllowsPermission(
	grant: PackageShareGrantRow,
	permission: PackageSharePermission,
) {
	return (
		grant.status === 'accepted' &&
		packageShareRoleAllows(grant.role, permission)
	)
}

export async function hydratePackageShareGrantView(input: {
	db: D1Database
	grant: PackageShareGrantRow
}): Promise<PackageShareGrantView | null> {
	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.grant.ownerUserId,
		packageId: input.grant.packageId,
	})
	if (!savedPackage) return null
	const [owner, grantee, publishedCommit] = await Promise.all([
		findPublicUserIdentityByStableUserId({
			db: input.db,
			userId: input.grant.ownerUserId,
		}),
		input.grant.granteeUserId
			? findPublicUserIdentityByStableUserId({
					db: input.db,
					userId: input.grant.granteeUserId,
				})
			: Promise.resolve(null),
		getPublishedCommitForPackage(input.db, savedPackage),
	])
	const ownerUsername = owner?.username
	if (!ownerUsername) return null
	const pinAhead =
		input.grant.status === 'accepted' &&
		input.grant.trustLevel === 'pin' &&
		publishedCommit != null &&
		input.grant.acceptedPublishedCommit != null &&
		publishedCommit !== input.grant.acceptedPublishedCommit
	return {
		...input.grant,
		packageName: savedPackage.name,
		packageKodyId: savedPackage.kodyId,
		ownerUsername,
		granteeUsername: grantee?.username ?? input.grant.inviteeUsername ?? null,
		publishedCommit,
		pinAhead,
		approveChangesPath: pinAhead
			? buildPackageShareApproveChangesPath({
					ownerUsername,
					kodyId: savedPackage.kodyId,
				})
			: null,
	}
}

export async function hydratePackageShareGrantViews(
	db: D1Database,
	grants: Array<PackageShareGrantRow>,
): Promise<Array<PackageShareGrantView>> {
	const views = await Promise.all(
		grants.map((grant) => hydratePackageShareGrantView({ db, grant })),
	)
	return views.filter((view): view is PackageShareGrantView => view != null)
}

export async function requireHydratedPackageShareGrantView(input: {
	db: D1Database
	grant: PackageShareGrantRow
}): Promise<PackageShareGrantView> {
	const view = await hydratePackageShareGrantView(input)
	if (!view) {
		throw new PackageShareAccessError(
			'Shared package was not found for this grant.',
		)
	}
	return view
}

export function grantIsAddressedToGuest(
	grant: PackageShareGrantRow,
	guestUserId: string,
	guestEmail: string | null,
	emailVerified = false,
) {
	if (grant.granteeUserId) {
		return grant.granteeUserId === guestUserId
	}
	return (
		grant.status === 'pending' &&
		emailVerified === true &&
		grant.inviteeEmail != null &&
		guestEmail != null &&
		grant.inviteeEmail === guestEmail
	)
}

export async function assertPackageShareUseAllowed(input: {
	db: D1Database
	grant: PackageShareGrantRow
	savedPackage: SavedPackageRecord
	guest: { userId: string; email?: string | null }
	ownerEmail?: string | null
}) {
	if (!grantAllowsPermission(input.grant, 'invoke')) {
		throw new PackageShareAccessError(
			'This package share grant does not allow invoke.',
		)
	}
	await assertPaidPlanForPackageShare(input.db, {
		userId: input.guest.userId,
		email: input.guest.email,
		who: 'You',
	})
	await assertPaidPlanForPackageShare(input.db, {
		userId: input.grant.ownerUserId,
		email: input.ownerEmail,
		who: 'The package owner',
	})
	const publishedCommit = await getPublishedCommitForPackage(
		input.db,
		input.savedPackage,
	)
	if (!publishedCommit) {
		throw new PackageShareAccessError(
			`Shared package ${input.savedPackage.name} has no published commit.`,
		)
	}
	if (input.grant.trustLevel === 'follow') return publishedCommit
	if (input.grant.trustLevel !== 'pin') {
		throw new PackageShareAccessError(
			'Accepted share grants must record a trust level.',
		)
	}
	if (input.grant.acceptedPublishedCommit === publishedCommit) {
		return publishedCommit
	}
	const owner = await findPublicUserIdentityByStableUserId({
		db: input.db,
		userId: input.grant.ownerUserId,
	})
	if (!owner?.username) {
		throw new PackageShareAccessError('Shared package owner was not found.')
	}
	const approveChangesPath = buildPackageShareApproveChangesPath({
		ownerUsername: owner.username,
		kodyId: input.savedPackage.kodyId,
	})
	throw new PackageSharePinAheadError(
		pinAheadMessage({
			packageName: input.savedPackage.name,
			approveChangesPath,
		}),
		approveChangesPath,
	)
}

export async function resolveShareGrantedPackageImport(input: {
	db: D1Database
	granteeUserId: string
	granteeEmail?: string | null
	packageName: string
}): Promise<{
	row: SavedPackageRecord
	sourceOwnerUserId: string
	grant: PackageShareGrantRow
} | null> {
	const found = await findAcceptedPackageShareGrantByName({
		db: input.db,
		packageName: input.packageName,
		granteeUserId: input.granteeUserId,
	})
	if (!found) return null
	await assertPackageShareUseAllowed({
		db: input.db,
		grant: found.grant,
		savedPackage: found.savedPackage,
		guest: { userId: input.granteeUserId, email: input.granteeEmail },
	})
	return {
		row: found.savedPackage,
		sourceOwnerUserId: found.grant.ownerUserId,
		grant: found.grant,
	}
}

export async function authorizeSharedPackagePermission(input: {
	db: D1Database
	packageId: string
	granteeUserId: string
	granteeEmail?: string | null
	permission: PackageSharePermission
}): Promise<{
	grant: PackageShareGrantRow
	savedPackage: SavedPackageRecord
} | null> {
	const grant = await findAcceptedPackageShareGrant({
		db: input.db,
		packageId: input.packageId,
		granteeUserId: input.granteeUserId,
	})
	if (!grant) return null
	if (!grantAllowsPermission(grant, input.permission)) return null
	const savedPackage = await getSavedPackageById(input.db, {
		userId: grant.ownerUserId,
		packageId: grant.packageId,
	})
	if (!savedPackage) return null
	if (input.permission === 'invoke') {
		await assertPackageShareUseAllowed({
			db: input.db,
			grant,
			savedPackage,
			guest: { userId: input.granteeUserId, email: input.granteeEmail },
		})
	} else {
		await assertPaidPlanForPackageShare(input.db, {
			userId: input.granteeUserId,
			email: input.granteeEmail,
			who: 'You',
		})
		await assertPaidPlanForPackageShare(input.db, {
			userId: grant.ownerUserId,
			email: null,
			who: 'The package owner',
		})
	}
	return { grant, savedPackage }
}

export async function isShareGrantedForeignPackage(input: {
	db: D1Database
	callerUserId: string
	packageId: string
}) {
	const grant = await findAcceptedPackageShareGrant({
		db: input.db,
		packageId: input.packageId,
		granteeUserId: input.callerUserId,
	})
	return grant != null
}

export async function resolvePackageStorageOwnerUserId(input: {
	db: D1Database
	callerUserId: string
	packageId: string
}) {
	const own = canPrepareAppDb(input.db)
		? await getSavedPackageById(input.db, {
				userId: input.callerUserId,
				packageId: input.packageId,
			})
		: null
	if (own) return input.callerUserId
	const grant = await findAcceptedPackageShareGrant({
		db: input.db,
		packageId: input.packageId,
		granteeUserId: input.callerUserId,
	})
	return grant?.ownerUserId ?? input.callerUserId
}

export async function collectShareStorageOwners(input: {
	db: D1Database
	callerUserId: string
	packageIds: Iterable<string>
}): Promise<Map<string, string>> {
	const owners = new Map<string, string>()
	if (!canPrepareAppDb(input.db)) return owners
	const packageIds = [
		...new Set(
			[...input.packageIds].filter((packageId) => packageId.length > 0),
		),
	]
	if (packageIds.length === 0) return owners
	return await queryShareGrantsOrEmpty(async () => {
		const placeholders = packageIds.map(() => '?').join(', ')
		const rows = await input.db
			.prepare(
				`SELECT package_id, owner_user_id
				FROM package_share_grants
				WHERE grantee_user_id = ?
					AND status = 'accepted'
					AND package_id IN (${placeholders})`,
			)
			.bind(input.callerUserId, ...packageIds)
			.all<{ package_id: string; owner_user_id: string }>()
		for (const row of rows.results ?? []) {
			if (row.owner_user_id && row.owner_user_id !== input.callerUserId) {
				owners.set(row.package_id, row.owner_user_id)
			}
		}
		return owners
	}, owners)
}

export async function retainAuthorizedPackageStorageGrantIds(input: {
	db: D1Database
	callerUserId: string
	packageIds: Iterable<string>
	storageOwnerByPackageId: ReadonlyMap<string, string>
}): Promise<Set<string>> {
	const retained = new Set<string>()
	for (const packageId of new Set(
		[...input.packageIds].filter((id) => id.length > 0),
	)) {
		if (input.storageOwnerByPackageId.has(packageId)) {
			retained.add(packageId)
			continue
		}
		try {
			const own = canPrepareAppDb(input.db)
				? await getSavedPackageById(input.db, {
						userId: input.callerUserId,
						packageId,
					})
				: null
			if (own) retained.add(packageId)
		} catch (error) {
			if (!/no such table/i.test(getErrorMessage(error))) throw error
		}
	}
	return retained
}

export async function invitePackageShare(input: {
	db: D1Database
	owner: McpUserContext
	packageId: string
	invitee: { username?: string; email?: string }
}): Promise<PackageShareGrantRow> {
	const ownerUserId = normalizeStableUserId(input.owner.userId)
	if (!ownerUserId) {
		throw new PackageShareAccessError('Owner user id is required.')
	}
	await assertPaidPlanForPackageShare(input.db, {
		userId: ownerUserId,
		email: input.owner.email,
		who: 'You',
	})
	const savedPackage = await getSavedPackageById(input.db, {
		userId: ownerUserId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new PackageShareAccessError(
			'Saved package not found for this user. Only the package owner can invite.',
		)
	}
	const username = input.invitee.username
		? normalizeUsername(input.invitee.username)
		: ''
	const emailInput = input.invitee.email?.trim() ?? ''
	if (!username && !emailInput) {
		throw new PackageShareAccessError(
			'Invite with a username or an email address.',
		)
	}
	let invitee: PublicUserIdentity | null = null
	let bindInvitee = false
	if (username) {
		invitee = await findPublicUserIdentityByUsername({
			db: input.db,
			username,
		})
		if (!invitee && !emailInput) {
			throw new PackageShareAccessError(
				`User "${username}" was not found. Invite by email to send an invite-before-signup.`,
			)
		}
		if (invitee) bindInvitee = true
	}
	if (!invitee && emailInput) {
		const foundByEmail = await findPersonUserByEmail(input.db, emailInput)
		if (foundByEmail) {
			const emailVerified = await isAccountEmailVerified({
				db: input.db,
				email: foundByEmail.email,
				stableUserId: foundByEmail.mcpUserId,
			})
			invitee = foundByEmail
			bindInvitee = emailVerified
		}
	}
	const inviteeEmail = emailInput ? normalizeEmailAddress(emailInput) : null
	if (emailInput && !inviteeEmail) {
		throw new PackageShareAccessError('Invite email address is invalid.')
	}
	if (invitee && invitee.mcpUserId === ownerUserId) {
		throw new PackageShareAccessError(
			'You cannot share a package with yourself.',
		)
	}
	if (
		inviteeEmail &&
		inviteeEmail === normalizeEmailAddress(input.owner.email ?? '')
	) {
		throw new PackageShareAccessError(
			'You cannot share a package with yourself.',
		)
	}
	const existing = await findConflictingPackageShareGrant({
		db: input.db,
		packageId: savedPackage.id,
		granteeUserId: invitee?.mcpUserId,
		inviteeEmail: inviteeEmail ?? invitee?.email,
	})
	if (existing) {
		throw new PackageShareAccessError(
			existing.status === 'accepted'
				? 'That person already has an accepted share grant for this package.'
				: 'An invitation for that person is already pending.',
		)
	}
	const invitedAt = nowIso()
	const id = crypto.randomUUID()
	try {
		await input.db
			.prepare(
				`INSERT INTO package_share_grants (
				id, package_id, owner_user_id, invitee_email, invitee_username,
				grantee_user_id, status, role, invited_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
			)
			.bind(
				id,
				savedPackage.id,
				ownerUserId,
				inviteeEmail,
				bindInvitee
					? (invitee?.username ?? (username || null))
					: username || null,
				bindInvitee ? (invitee?.mcpUserId ?? null) : null,
				defaultPackageShareRole,
				invitedAt,
				invitedAt,
				invitedAt,
			)
			.run()
	} catch (error) {
		if (/UNIQUE constraint failed/i.test(getErrorMessage(error))) {
			throw new PackageShareAccessError(
				'An invitation for that person is already pending or accepted.',
			)
		}
		throw error
	}
	const created = await getPackageShareGrantById(input.db, id)
	if (!created) {
		throw new Error('Package share invite was not persisted.')
	}
	return created
}

export async function acceptPackageShare(input: {
	db: D1Database
	guest: McpUserContext
	grantId?: string
	packageId?: string
	trustLevel?: PackageShareTrustLevel
}): Promise<PackageShareGrantRow> {
	const guestUserId = normalizeStableUserId(input.guest.userId)
	if (!guestUserId) {
		throw new PackageShareAccessError('Guest user id is required.')
	}
	await assertPaidPlanForPackageShare(input.db, {
		userId: guestUserId,
		email: input.guest.email,
		who: 'You',
	})
	const grant = input.grantId
		? await getPackageShareGrantById(input.db, input.grantId)
		: input.packageId
			? await findActivePackageShareGrant({
					db: input.db,
					packageId: input.packageId,
					granteeUserId: guestUserId,
					inviteeEmail: input.guest.email,
				})
			: null
	if (!grant || grant.status !== 'pending') {
		throw new PackageShareAccessError(
			'No pending package share invitation was found for you.',
		)
	}
	const guestEmail = normalizeEmailAddress(input.guest.email ?? '')
	const emailVerified = await isAccountEmailVerified({
		db: input.db,
		email: input.guest.email,
		stableUserId: guestUserId,
	})
	if (!grantIsAddressedToGuest(grant, guestUserId, guestEmail, emailVerified)) {
		throw new PackageShareAccessError(
			'This invitation is not addressed to the signed-in account.',
		)
	}
	await assertPaidPlanForPackageShare(input.db, {
		userId: grant.ownerUserId,
		email: null,
		who: 'The package owner',
	})
	const savedPackage = await getSavedPackageById(input.db, {
		userId: grant.ownerUserId,
		packageId: grant.packageId,
	})
	if (!savedPackage) {
		throw new PackageShareAccessError('Shared package was not found.')
	}
	const publishedCommit = await getPublishedCommitForPackage(
		input.db,
		savedPackage,
	)
	if (!publishedCommit) {
		throw new PackageShareAccessError(
			`Shared package ${savedPackage.name} has no published commit to accept.`,
		)
	}
	const trustLevel = input.trustLevel ?? defaultPackageShareTrustLevel
	const acceptedAt = nowIso()
	await input.db
		.prepare(
			`UPDATE package_share_grants
			SET status = 'accepted',
				grantee_user_id = ?,
				trust_level = ?,
				accepted_published_commit = ?,
				accepted_at = ?,
				last_acknowledged_at = ?,
				updated_at = ?
			WHERE id = ? AND status = 'pending'`,
		)
		.bind(
			guestUserId,
			trustLevel,
			publishedCommit,
			acceptedAt,
			acceptedAt,
			acceptedAt,
			grant.id,
		)
		.run()
	const accepted = await getPackageShareGrantById(input.db, grant.id)
	if (!accepted || accepted.status !== 'accepted') {
		throw new PackageShareAccessError(
			'The invitation could not be accepted. It may have been revoked.',
		)
	}
	return accepted
}

export async function revokePackageShare(input: {
	db: D1Database
	ownerUserId: string
	grantId: string
}): Promise<PackageShareGrantRow> {
	const grant = await getPackageShareGrantById(input.db, input.grantId)
	if (!grant || grant.ownerUserId !== input.ownerUserId) {
		throw new PackageShareAccessError(
			'Share grant not found for a package you own.',
		)
	}
	if (grant.status === 'revoked') return grant
	const revokedAt = nowIso()
	await input.db
		.prepare(
			`UPDATE package_share_grants
			SET status = 'revoked', revoked_at = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(revokedAt, revokedAt, grant.id)
		.run()
	const revoked = await getPackageShareGrantById(input.db, grant.id)
	if (!revoked) {
		throw new Error('Package share revoke did not persist.')
	}
	return revoked
}

export async function leavePackageShare(input: {
	db: D1Database
	granteeUserId: string
	grantId: string
}): Promise<PackageShareGrantRow> {
	const grant = await getPackageShareGrantById(input.db, input.grantId)
	if (!grant || grant.granteeUserId !== input.granteeUserId) {
		throw new PackageShareAccessError(
			'Share grant not found for a package shared with you.',
		)
	}
	if (grant.status === 'left' || grant.status === 'revoked') return grant
	const leftAt = nowIso()
	await input.db
		.prepare(
			`UPDATE package_share_grants
			SET status = 'left', left_at = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(leftAt, leftAt, grant.id)
		.run()
	const left = await getPackageShareGrantById(input.db, grant.id)
	if (!left) {
		throw new Error('Package share leave did not persist.')
	}
	return left
}

export async function acknowledgePackageShareUpdate(input: {
	db: D1Database
	granteeUserId: string
	grantId: string
	switchToFollow?: boolean
	expectedPublishedCommit?: string
}): Promise<PackageShareGrantRow> {
	const grant = await getPackageShareGrantById(input.db, input.grantId)
	if (
		!grant ||
		grant.granteeUserId !== input.granteeUserId ||
		grant.status !== 'accepted'
	) {
		throw new PackageShareAccessError(
			'Accepted share grant not found for a package shared with you.',
		)
	}
	const savedPackage = await getSavedPackageById(input.db, {
		userId: grant.ownerUserId,
		packageId: grant.packageId,
	})
	if (!savedPackage) {
		throw new PackageShareAccessError('Shared package was not found.')
	}
	const publishedCommit = await getPublishedCommitForPackage(
		input.db,
		savedPackage,
	)
	if (!publishedCommit) {
		throw new PackageShareAccessError(
			`Shared package ${savedPackage.name} has no published commit to approve.`,
		)
	}
	if (input.switchToFollow !== true) {
		const expectedPublishedCommit = input.expectedPublishedCommit?.trim() ?? ''
		if (!expectedPublishedCommit) {
			throw new PackageShareAccessError(
				'Pin approval must name the published commit that was reviewed.',
			)
		}
		if (publishedCommit !== expectedPublishedCommit) {
			throw new PackageShareAccessError(
				'The published package changed since this review. Reload and approve the current commit.',
			)
		}
	}
	const trustLevel =
		input.switchToFollow === true ? 'follow' : (grant.trustLevel ?? 'pin')
	const acknowledgedAt = nowIso()
	await input.db
		.prepare(
			`UPDATE package_share_grants
			SET accepted_published_commit = ?,
				trust_level = ?,
				last_acknowledged_at = ?,
				updated_at = ?
			WHERE id = ? AND status = 'accepted'`,
		)
		.bind(publishedCommit, trustLevel, acknowledgedAt, acknowledgedAt, grant.id)
		.run()
	const updated = await getPackageShareGrantById(input.db, grant.id)
	if (!updated) {
		throw new Error('Package share acknowledge did not persist.')
	}
	return updated
}

export async function attachPendingPackageShareInvitesForEmail(input: {
	db: D1Database
	userId: string
	email: string
	username?: string | null
}) {
	const email = normalizeEmailAddress(input.email)
	if (!email || !canPrepareAppDb(input.db)) return { attached: 0 }
	const emailVerified = await isAccountEmailVerified({
		db: input.db,
		email,
		stableUserId: input.userId,
	})
	if (!emailVerified) return { attached: 0 }
	return await queryShareGrantsOrEmpty(
		async () => {
			const username = input.username ? normalizeUsername(input.username) : null
			const result = await input.db
				.prepare(
					`UPDATE package_share_grants
				SET grantee_user_id = ?,
					invitee_username = COALESCE(?, invitee_username),
					updated_at = ?
				WHERE invitee_email = ?
					AND status = 'pending'
					AND grantee_user_id IS NULL`,
				)
				.bind(input.userId, username, nowIso(), email)
				.run()
			return { attached: result.meta.changes ?? 0 }
		},
		{ attached: 0 },
	)
}

export async function attachPendingPackageShareInvitesSafely(input: {
	db: D1Database
	userId: string
	email: string
	username?: string | null
}) {
	try {
		return await attachPendingPackageShareInvitesForEmail(input)
	} catch (error) {
		console.error('package-share-invite-attach-failed', error)
		return { attached: 0 }
	}
}

export async function resolveOwnedOrSharedPackage(input: {
	db: D1Database
	caller: { userId: string; email?: string | null }
	packageId: string
	permission: PackageSharePermission
}): Promise<{
	savedPackage: SavedPackageRecord
	access: 'owner' | 'share'
	grant: PackageShareGrantRow | null
}> {
	const own = await getSavedPackageById(input.db, {
		userId: input.caller.userId,
		packageId: input.packageId,
	})
	if (own) {
		return { savedPackage: own, access: 'owner', grant: null }
	}
	const shared = await authorizeSharedPackagePermission({
		db: input.db,
		packageId: input.packageId,
		granteeUserId: input.caller.userId,
		granteeEmail: input.caller.email,
		permission: input.permission,
	})
	if (!shared) {
		throw new PackageShareAccessError('Saved package not found for this user.')
	}
	return {
		savedPackage: shared.savedPackage,
		access: 'share',
		grant: shared.grant,
	}
}

export function packageShareAccessErrorMessage(error: unknown) {
	if (error instanceof PackageShareAccessError) return error.message
	return getErrorMessage(error)
}

export async function loadViewerPackageShare(input: {
	db: D1Database
	packageId: string
	viewer?: {
		userId?: string | null
		email?: string | null
		emailVerified?: boolean
	} | null
}): Promise<PackageShareGrantView | null> {
	if (!input.viewer?.userId && !input.viewer?.email) return null
	const grant = await findActivePackageShareGrant({
		db: input.db,
		packageId: input.packageId,
		granteeUserId: input.viewer.userId,
		inviteeEmail: input.viewer.email,
	})
	if (!grant) return null
	if (
		!grantIsAddressedToGuest(
			grant,
			input.viewer.userId ?? '',
			input.viewer.email ? normalizeEmailAddress(input.viewer.email) : null,
			input.viewer.emailVerified === true,
		)
	) {
		return null
	}
	return await hydratePackageShareGrantView({ db: input.db, grant })
}

export async function listAcceptedInboundSharedPackages(input: {
	db: D1Database
	granteeUserId: string
}): Promise<Array<SavedPackageRecord>> {
	const grants = await listInboundPackageShareGrants(input.db, {
		userId: input.granteeUserId,
	})
	const accepted = grants.filter((grant) => grant.status === 'accepted')
	const packages: Array<SavedPackageRecord> = []
	for (const grant of accepted) {
		const saved = await getSavedPackageById(input.db, {
			userId: grant.ownerUserId,
			packageId: grant.packageId,
		})
		if (!saved) continue
		if (grant.trustLevel === 'pin') {
			const publishedCommit = await getPublishedCommitForPackage(
				input.db,
				saved,
			)
			if (
				!publishedCommit ||
				grant.acceptedPublishedCommit !== publishedCommit
			) {
				continue
			}
		}
		packages.push(saved)
	}
	return packages
}
