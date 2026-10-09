import { writeFile } from 'node:fs/promises'
import { isExecutedDirectly } from '../node-runtime.ts'
import { fail } from '../ci/resource-utils.ts'
import {
	queryD1,
	type CloudflareClient,
} from '../preview-rehearsal/d1-rehearsal.ts'
import {
	importRecipientPublicKey,
	sealJson,
	type SealedEnvelope,
} from '../preview-rehearsal/seal.ts'
import {
	parseQueryTarget,
	readOnlyD1Query,
	resolveD1Uuid,
	targetAppD1Name,
	type QueryTarget,
} from './production-queries.ts'

/**
 * Companion to migration 0091 (Teams P8): the sealed pre-conversion backup,
 * a read-only re-check of the converted state, and an explicit repair for the
 * gaps a re-check can name. The conversion itself is the migration, which
 * fails closed on the same invariants; the SQL below mirrors its population
 * rules so a gap here means the migration's result was lost or changed after
 * it applied.
 */

export const kodyCreditNote = 'Teams P8: site-admin credit for @kody org'
export const kodyCreditMicroUsd = 1_000_000_000
const kodyCreditLedgerId = 'teams-p8-kody-site-admin-credit'

/**
 * Accepted shares the migration converts: the package, the owner's org, and
 * the grantee still exist.
 */
const convertibleAcceptedShares = `FROM package_share_grants s
WHERE s.status = 'accepted'
	AND s.grantee_user_id IS NOT NULL
	AND s.grantee_user_id <> s.owner_user_id
	AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = s.owner_user_id)
	AND EXISTS (
		SELECT 1 FROM saved_packages p
		WHERE p.id = s.package_id AND p.user_id = s.owner_user_id
	)
	AND EXISTS (SELECT 1 FROM users g WHERE g.stable_user_id = s.grantee_user_id)`

/**
 * Pending shares the migration converts, with the invitee the invite matches
 * on: the share's email, else its username, else the grantee's username.
 */
const convertiblePendingShares = `FROM (
	SELECT
		s.id AS share_id,
		s.owner_user_id AS org_id,
		s.package_id,
		NULLIF(LOWER(TRIM(COALESCE(s.invitee_email, ''))), '') AS invitee_email,
		COALESCE(
			NULLIF(LOWER(TRIM(COALESCE(s.invitee_username, ''))), ''),
			(SELECT LOWER(g.username) FROM users g WHERE g.stable_user_id = s.grantee_user_id)
		) AS invitee_username
	FROM package_share_grants s
	WHERE s.status = 'pending'
		AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = s.owner_user_id)
		AND EXISTS (
			SELECT 1 FROM saved_packages p
			WHERE p.id = s.package_id AND p.user_id = s.owner_user_id
		)
) pending
WHERE (pending.invitee_email IS NOT NULL OR pending.invitee_username IS NOT NULL)`

export const conversionChecks = [
	{
		name: 'accepted-share-use-grant',
		description: 'Every accepted share has a live Use grant',
		sql: `SELECT COUNT(*) AS gaps ${convertibleAcceptedShares}
	AND NOT EXISTS (
		SELECT 1 FROM grants g
		INNER JOIN grant_permissions read_permission
			ON read_permission.grant_id = g.id AND read_permission.permission = 'package:read'
		INNER JOIN grant_permissions execute_permission
			ON execute_permission.grant_id = g.id AND execute_permission.permission = 'package:execute'
		WHERE g.org_id = s.owner_user_id
			AND g.resource_type = 'package'
			AND g.resource_id = s.package_id
			AND g.subject_type = 'user'
			AND g.subject_id = s.grantee_user_id
			AND g.deleted_at IS NULL
	)`,
	},
	{
		name: 'pending-share-grant-invite',
		description: 'Every pending share has a pending grant invite',
		sql: `SELECT COUNT(*) AS gaps ${convertiblePendingShares}
	AND NOT EXISTS (
		SELECT 1 FROM invites i
		WHERE i.org_id = pending.org_id
			AND i.kind = 'grant'
			AND i.status = 'pending'
			AND i.resource_type = 'package'
			AND i.resource_id = pending.package_id
			AND (
				(pending.invitee_email IS NOT NULL AND i.invitee_email = pending.invitee_email)
				OR (pending.invitee_email IS NULL AND i.invitee_username = pending.invitee_username)
			)
	)`,
	},
	{
		name: 'scope-grantee-owner-membership',
		description: 'Every scope grantee is a live Owner of the scope org',
		sql: `SELECT COUNT(*) AS gaps
FROM package_scope_grants sg
WHERE EXISTS (SELECT 1 FROM orgs o WHERE o.id = sg.scope_owner_user_id)
	AND EXISTS (SELECT 1 FROM users u WHERE u.stable_user_id = sg.grantee_user_id)
	AND NOT EXISTS (
		SELECT 1 FROM org_memberships m
		WHERE m.org_id = sg.scope_owner_user_id
			AND m.user_id = sg.grantee_user_id
			AND m.role = 'owner'
			AND m.deleted_at IS NULL
	)`,
	},
	{
		name: 'platform-org-pro',
		description:
			'Every platform account has an org on plan pro with admin credits',
		sql: `SELECT COUNT(*) AS gaps
FROM users u
LEFT JOIN orgs o ON o.id = u.stable_user_id
WHERE u.account_type = 'platform'
	AND (o.id IS NULL OR o.plan <> 'pro' OR o.admin_credits_eligible <> 1)`,
	},
	{
		name: 'platform-user-pro',
		description:
			'Every platform users row mirrors plan pro with admin credits until P9',
		sql: `SELECT COUNT(*) AS gaps
FROM users u
WHERE u.account_type = 'platform'
	AND (u.plan <> 'pro' OR u.admin_credits_eligible <> 1)`,
	},
	{
		name: 'kody-site-admin-credit',
		description: 'The @kody org has its site-admin credit ledger entry once',
		sql: `SELECT COUNT(*) AS gaps
FROM users u
WHERE u.username = 'kody'
	AND u.account_type = 'platform'
	AND (
		SELECT COUNT(*) FROM credit_ledger_entries l
		WHERE l.user_id = u.stable_user_id
			AND l.kind = 'admin_grant'
			AND l.amount_micro_usd = ${kodyCreditMicroUsd}
			AND l.note = '${kodyCreditNote}'
	) <> 1`,
	},
	{
		name: 'kody-wallet',
		description: 'The @kody org has a credit wallet',
		sql: `SELECT COUNT(*) AS gaps
FROM users u
WHERE u.username = 'kody'
	AND u.account_type = 'platform'
	AND NOT EXISTS (SELECT 1 FROM credit_wallets w WHERE w.user_id = u.stable_user_id)`,
	},
] as const

export type ConversionCheckName = (typeof conversionChecks)[number]['name']

const conversionCountsSql = `SELECT
	(SELECT COUNT(*) ${convertibleAcceptedShares}) AS accepted_shares,
	(SELECT COUNT(*) ${convertiblePendingShares}) AS pending_shares,
	(SELECT COUNT(*) FROM package_scope_grants) AS scope_grantees,
	(SELECT COUNT(*) FROM users WHERE account_type = 'platform') AS platform_accounts,
	(SELECT COALESCE(SUM(w.balance_micro_usd), 0)
		FROM credit_wallets w
		INNER JOIN users u ON u.stable_user_id = w.user_id
		WHERE u.username = 'kody' AND u.account_type = 'platform') AS kody_balance_micro_usd`

export type ConversionCheckResult = {
	name: ConversionCheckName
	description: string
	gaps: number
}

export type ConversionReport = {
	version: 1
	target: string
	ranAt: string
	ok: boolean
	checks: Array<ConversionCheckResult>
	counts: {
		acceptedShares: number
		pendingShares: number
		scopeGrantees: number
		platformAccounts: number
		kodyBalanceMicroUsd: number
	}
}

export type PreConversionBackup = {
	version: 1
	target: string
	takenAt: string
	packageShareGrants: Array<Record<string, unknown>>
	packageScopeGrants: Array<Record<string, unknown>>
	platformUsers: Array<Record<string, unknown>>
}

function toNumber(value: unknown) {
	const number = Number(value)
	if (!Number.isFinite(number)) throw new Error(`Expected a number: ${value}`)
	return number
}

function targetName(target: QueryTarget) {
	return target.kind === 'production' ? 'production' : target.workerName
}

async function resolveAppDatabase(
	client: CloudflareClient,
	target: QueryTarget,
) {
	return resolveD1Uuid(client, targetAppD1Name(target))
}

/**
 * Dumps the rows the conversion reads (all share grants, all scope grants, and
 * the platform `users` rows) and seals them to the operator's key. Password
 * hashes are left out. D1 Time Travel is the full-database rollback; this is
 * the readable record of what the conversion started from.
 */
export async function sealPreConversionBackup(input: {
	client: CloudflareClient
	target: QueryTarget
	recipientPublicKey: CryptoKey
	now?: () => Date
}): Promise<SealedEnvelope> {
	const uuid = await resolveAppDatabase(input.client, input.target)
	const read = (sql: string) =>
		readOnlyD1Query<Record<string, unknown>>(input.client, uuid, sql)
	const platformUsers = (
		await read(
			`SELECT * FROM users WHERE account_type = 'platform' ORDER BY username`,
		)
	).map(({ password_hash: _passwordHash, ...row }) => row)
	const backup: PreConversionBackup = {
		version: 1,
		target: targetName(input.target),
		takenAt: (input.now ?? (() => new Date()))().toISOString(),
		packageShareGrants: await read(
			`SELECT * FROM package_share_grants ORDER BY id`,
		),
		packageScopeGrants: await read(
			`SELECT * FROM package_scope_grants ORDER BY scope_owner_user_id, grantee_user_id`,
		),
		platformUsers,
	}
	return sealJson(backup, input.recipientPublicKey)
}

/** Read-only re-check of every migration 0091 invariant. */
export async function verifyConversion(input: {
	client: CloudflareClient
	target: QueryTarget
	now?: () => Date
}): Promise<ConversionReport> {
	const uuid = await resolveAppDatabase(input.client, input.target)
	const checks: Array<ConversionCheckResult> = []
	for (const check of conversionChecks) {
		const [row] = await readOnlyD1Query<Record<string, unknown>>(
			input.client,
			uuid,
			check.sql,
		)
		checks.push({
			name: check.name,
			description: check.description,
			gaps: toNumber(row?.['gaps']),
		})
	}
	const [counts] = await readOnlyD1Query<Record<string, unknown>>(
		input.client,
		uuid,
		conversionCountsSql,
	)
	return {
		version: 1,
		target: targetName(input.target),
		ranAt: (input.now ?? (() => new Date()))().toISOString(),
		ok: checks.every((check) => check.gaps === 0),
		checks,
		counts: {
			acceptedShares: toNumber(counts?.['accepted_shares']),
			pendingShares: toNumber(counts?.['pending_shares']),
			scopeGrantees: toNumber(counts?.['scope_grantees']),
			platformAccounts: toNumber(counts?.['platform_accounts']),
			kodyBalanceMicroUsd: toNumber(counts?.['kody_balance_micro_usd']),
		},
	}
}

/** D1 runs a multi-statement query as one batch (a single transaction). */
export const d1BatchSeparator = ';\n'

function joinBatch(statements: ReadonlyArray<string>) {
	return statements.join(d1BatchSeparator)
}

const nowIso = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

/**
 * Idempotent writes for the gaps a re-check can repair: scope-grantee Owner
 * memberships, platform org plan and credit eligibility, and the @kody credit.
 * Share grants and invites are not repaired here. Restore from the backup or
 * D1 Time Travel and re-apply the migration instead.
 */
export const repairStatements: ReadonlyArray<{ name: string; sql: string }> = [
	{
		name: 'scope-grantee-owner-membership',
		sql: `INSERT INTO org_memberships (org_id, user_id, role, invited_by_user_id, created_at, deleted_at)
SELECT sg.scope_owner_user_id, sg.grantee_user_id, 'owner', sg.created_by_user_id, COALESCE(sg.created_at, ${nowIso}), NULL
FROM package_scope_grants sg
WHERE EXISTS (SELECT 1 FROM orgs o WHERE o.id = sg.scope_owner_user_id)
	AND EXISTS (SELECT 1 FROM users u WHERE u.stable_user_id = sg.grantee_user_id)
ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner', deleted_at = NULL`,
	},
	{
		name: 'scope-grantee-access-epoch',
		sql: `UPDATE orgs SET access_epoch = access_epoch + 1, updated_at = ${nowIso}
WHERE id IN (SELECT scope_owner_user_id FROM package_scope_grants)`,
	},
	{
		name: 'platform-org-pro',
		sql: `UPDATE orgs SET plan = 'pro', admin_credits_eligible = 1, updated_at = ${nowIso}
WHERE id IN (SELECT stable_user_id FROM users WHERE account_type = 'platform')
	AND (plan <> 'pro' OR admin_credits_eligible <> 1)`,
	},
	{
		// Dual-write until Teams P9 drops users.plan and
		// users.admin_credits_eligible (#3084): admin and campaign paths still
		// read them from users.
		name: 'platform-user-pro',
		sql: `UPDATE users SET plan = 'pro', admin_credits_eligible = 1, updated_at = ${nowIso}
WHERE account_type = 'platform'
	AND (plan <> 'pro' OR admin_credits_eligible <> 1)`,
	},
	{
		name: 'kody-wallet',
		sql: `INSERT OR IGNORE INTO credit_wallets (user_id, created_at, updated_at)
SELECT u.stable_user_id, ${nowIso}, ${nowIso}
FROM users u
WHERE u.username = 'kody' AND u.account_type = 'platform'`,
	},
	{
		// One D1 query is one batch: the ledger row and the wallet bump apply
		// together or not at all. The bump runs only when the ledger insert
		// wrote its row (changes() = 1), so a repeat never credits twice.
		name: 'kody-credit',
		sql: joinBatch([
			`INSERT INTO credit_ledger_entries (id, user_id, kind, amount_micro_usd, month, granted_by_user_id, note, created_at)
SELECT '${kodyCreditLedgerId}', u.stable_user_id, 'admin_grant', ${kodyCreditMicroUsd}, strftime('%Y-%m', 'now'), NULL, '${kodyCreditNote}', ${nowIso}
FROM users u
WHERE u.username = 'kody'
	AND u.account_type = 'platform'
	AND EXISTS (SELECT 1 FROM credit_wallets w WHERE w.user_id = u.stable_user_id)
	AND NOT EXISTS (
		SELECT 1 FROM credit_ledger_entries l
		WHERE l.user_id = u.stable_user_id
			AND l.kind = 'admin_grant'
			AND l.note = '${kodyCreditNote}'
	)`,
			`UPDATE credit_wallets
SET balance_micro_usd = balance_micro_usd + ${kodyCreditMicroUsd}, updated_at = ${nowIso}
WHERE changes() = 1
	AND user_id IN (
		SELECT stable_user_id FROM users WHERE username = 'kody' AND account_type = 'platform'
	)`,
		]),
	},
]

/** Applies the repair writes, then re-verifies and returns that report. */
export async function repairConversion(input: {
	client: CloudflareClient
	target: QueryTarget
	now?: () => Date
}): Promise<ConversionReport> {
	const uuid = await resolveAppDatabase(input.client, input.target)
	for (const statement of repairStatements) {
		await queryD1(input.client, uuid, statement.sql)
	}
	return verifyConversion(input)
}

export const conversionModes = ['backup', 'verify', 'repair'] as const
export type ConversionMode = (typeof conversionModes)[number]

const usage = [
	'Usage: node tools/teams-migration/convert-sharing-and-platform.ts --mode <backup|verify|repair> --target <production|kody-branch-*> --recipient-public-key <base64 SPKI> --out <file.sealed.json>',
	'',
	'backup  Seal package_share_grants, package_scope_grants, and platform users rows (read-only).',
	'verify  Re-check every migration 0091 invariant (read-only). Exits 1 when any check has gaps.',
	'repair  Apply the idempotent repair writes, then verify. Needs --confirm-repair.',
	'',
	'Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.',
].join('\n')

function readFlag(argv: ReadonlyArray<string>, flag: string) {
	const index = argv.indexOf(flag)
	const value = index === -1 ? undefined : argv[index + 1]
	if (!value || value.startsWith('--'))
		fail(`Missing ${flag} <value>.\n${usage}`)
	return value
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) fail(`${name} is required.\n${usage}`)
	return value
}

function parseMode(value: string): ConversionMode {
	const mode = conversionModes.find((candidate) => candidate === value)
	if (!mode)
		fail(`--mode must be one of ${conversionModes.join(', ')}.\n${usage}`)
	return mode
}

if (isExecutedDirectly(import.meta.url)) {
	const argv = process.argv.slice(2)
	const mode = parseMode(readFlag(argv, '--mode'))
	const target = parseQueryTarget(readFlag(argv, '--target'))
	const publicKey = await importRecipientPublicKey(
		readFlag(argv, '--recipient-public-key'),
	)
	const outPath = readFlag(argv, '--out')
	const client: CloudflareClient = {
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
	}
	const write = async (value: unknown) =>
		writeFile(outPath, `${JSON.stringify(value, null, 2)}\n`)
	switch (mode) {
		case 'backup': {
			await write(
				await sealPreConversionBackup({
					client,
					target,
					recipientPublicKey: publicKey,
				}),
			)
			console.log(`Wrote the sealed pre-conversion backup to ${outPath}.`)
			break
		}
		case 'verify':
		case 'repair': {
			if (mode === 'repair' && !argv.includes('--confirm-repair')) {
				fail(`repair writes to ${targetName(target)}; pass --confirm-repair.`)
			}
			const report =
				mode === 'repair'
					? await repairConversion({ client, target })
					: await verifyConversion({ client, target })
			await write(await sealJson(report, publicKey))
			const failing = report.checks.filter((check) => check.gaps > 0)
			if (failing.length > 0) {
				fail(
					`Conversion checks failed on ${report.target}: ${failing.map((check) => check.name).join(', ')}. Counts are in the sealed report at ${outPath}.`,
				)
			}
			console.log(
				`All ${report.checks.length} conversion checks passed on ${report.target}. Sealed report at ${outPath}.`,
			)
			break
		}
		default: {
			const exhaustive: never = mode
			fail(`Unknown mode: ${String(exhaustive)}`)
		}
	}
}
