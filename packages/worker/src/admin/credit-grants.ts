/**
 * Admin credit grants: house-funded wallet top-ups for any account,
 * including the signed-in admin. Shared by the admin users page and the
 * `adminCreditGrant` / `adminCreditWalletGet` capabilities so both write
 * the same ledger row (granted_by, amount, recipient, time, note) and the
 * same audit event.
 */
import {
	type AdminCreditLedgerItem,
	type AdminCreditWalletSummary,
} from '#universal/loader-data.ts'
import {
	creditAdminGrantNoteMaxLength,
	validateCreditAdminGrantCents,
} from '#universal/credits.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	ensureCreditWallet,
	grantAdminCredits,
	listCreditLedgerEntries,
	readCreditWallet,
	toAccountCreditsLedgerItem,
} from '#worker/billing/credit-wallet.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { isStableUserId, normalizeStableUserId } from '#worker/user-id.ts'
import { type AdminUserTarget } from './users-data.ts'

const adminCreditLedgerLimit = 20

export class AdminCreditGrantError extends Error {
	readonly status: 400 | 404
	constructor(status: 400 | 404, message: string) {
		super(message)
		this.name = 'AdminCreditGrantError'
		this.status = status
	}
}

type CreditGrantTargetRow = UserEntitlementRow & {
	stable_user_id: string
	username: string
}

async function loadCreditGrantTarget(
	db: D1Database,
	target: AdminUserTarget,
): Promise<CreditGrantTargetRow | null> {
	const columns = `stable_user_id, username, ${userEntitlementColumnsSql()}`
	if (target.stableUserId !== undefined) {
		const stableUserId = normalizeStableUserId(target.stableUserId)
		if (!isStableUserId(stableUserId)) return null
		return db
			.prepare(`SELECT ${columns} FROM users WHERE stable_user_id = ?`)
			.bind(stableUserId)
			.first<CreditGrantTargetRow>()
	}
	if (target.email !== undefined) {
		return db
			.prepare(`SELECT ${columns} FROM users WHERE lower(email) = ?`)
			.bind(normalizeEmail(target.email))
			.first<CreditGrantTargetRow>()
	}
	if (target.username !== undefined) {
		return db
			.prepare(`SELECT ${columns} FROM users WHERE username = ?`)
			.bind(target.username.trim())
			.first<CreditGrantTargetRow>()
	}
	return null
}

async function loadGranterUsernames(
	db: D1Database,
	stableUserIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
	const unique = [...new Set(stableUserIds)]
	if (unique.length === 0) return new Map()
	const rows = await db
		.prepare(
			`SELECT stable_user_id, username FROM users
			 WHERE stable_user_id IN (${unique.map(() => '?').join(', ')})`,
		)
		.bind(...unique)
		.all<{ stable_user_id: string; username: string }>()
	return new Map(
		(rows.results ?? []).map((row) => [row.stable_user_id, row.username]),
	)
}

export async function loadAdminCreditWallet(
	env: Env,
	target: AdminUserTarget,
): Promise<AdminCreditWalletSummary | null> {
	const db = env.APP_DB
	const row = await loadCreditGrantTarget(db, target)
	if (!row) return null
	const stableUserId = row.stable_user_id
	const [entitlement, wallet, entries] = await Promise.all([
		resolveUserEntitlementFromRow({ db, stableUserId, row }),
		readCreditWallet(db, stableUserId),
		listCreditLedgerEntries({
			db,
			userId: stableUserId,
			limit: adminCreditLedgerLimit,
		}),
	])
	const granters = await loadGranterUsernames(
		db,
		entries.flatMap((entry) =>
			entry.grantedByUserId ? [entry.grantedByUserId] : [],
		),
	)
	const recent: Array<AdminCreditLedgerItem> = entries.map((entry) => ({
		...toAccountCreditsLedgerItem(entry),
		grantedByUsername: entry.grantedByUserId
			? (granters.get(entry.grantedByUserId) ?? 'deleted-user')
			: null,
		note: entry.note,
	}))
	return {
		ok: true,
		stableUserId,
		username: row.username,
		plan: entitlement.plan,
		eligible: entitlement.creditWallet !== 'none',
		unlocked: entitlement.creditWallet === 'funded',
		balanceMicroUsd: wallet.balanceMicroUsd,
		recent,
	}
}

export function parseAdminCreditGrantNote(value: unknown): string | null {
	if (value === undefined || value === null) return null
	if (typeof value !== 'string') {
		throw new AdminCreditGrantError(400, 'Note must be text.')
	}
	const note = value.trim()
	if (note.length > creditAdminGrantNoteMaxLength) {
		throw new AdminCreditGrantError(
			400,
			`Note is limited to ${creditAdminGrantNoteMaxLength} characters.`,
		)
	}
	return note || null
}

export async function grantAdminCreditsToUser(input: {
	env: Env
	target: AdminUserTarget
	grantedBy: { stableUserId: string; email: string }
	amountCents: unknown
	note: unknown
	path: string
	ip?: string
	/** MCP callers audit through `auditAdminCapabilityInvocation` instead. */
	audit?: boolean
	now?: Date
}): Promise<{
	entryId: string
	amountCents: number
	wallet: AdminCreditWalletSummary
}> {
	const amount = validateCreditAdminGrantCents(input.amountCents)
	if (!amount.ok) throw new AdminCreditGrantError(400, amount.error)
	const note = parseAdminCreditGrantNote(input.note)
	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	const row = await loadCreditGrantTarget(db, input.target)
	if (!row) throw new AdminCreditGrantError(404, 'User not found.')
	const user = { stableUserId: row.stable_user_id }
	await ensureCreditWallet({
		db,
		userId: user.stableUserId,
		entitlement: await resolveUserEntitlementFromRow({
			db,
			stableUserId: user.stableUserId,
			row,
			now,
		}),
		now,
	})
	const grant = await grantAdminCredits({
		db,
		recipientUserId: user.stableUserId,
		grantedByUserId: input.grantedBy.stableUserId,
		amountCents: amount.cents,
		note,
		now,
	})
	if (input.audit !== false) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: 'grant_credits',
			result: 'success',
			email: input.grantedBy.email,
			ip: input.ip,
			path: input.path,
			reason: formatAdminCreditGrantAuditReason({
				stableUserId: user.stableUserId,
				amountCents: amount.cents,
				entryId: grant.entryId,
			}),
		})
	}
	const wallet = await loadAdminCreditWallet(input.env, {
		stableUserId: user.stableUserId,
	})
	if (!wallet) throw new AdminCreditGrantError(404, 'User not found.')
	return { entryId: grant.entryId, amountCents: amount.cents, wallet }
}

export function formatAdminCreditGrantAuditReason(input: {
	stableUserId: string
	amountCents: number
	entryId: string
}) {
	return `target_stable_user_id=${input.stableUserId};amount_cents=${input.amountCents};entry_id=${input.entryId}`
}
