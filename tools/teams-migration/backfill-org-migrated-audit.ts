import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
	buildPreviewResourceNames,
	previewResourceNamePattern,
} from '../ci/preview-resources.ts'
import { fail, parseJsonc } from '../ci/resource-utils.ts'
import {
	queryD1,
	queryD1Changes,
	type CloudflareClient,
} from '../preview-rehearsal/d1-rehearsal.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import { resolveD1Uuid } from './production-queries.ts'

/**
 * Insert one `org.migrated` success row per org (ADR 0063). A repeat inserts
 * nothing. Deploy does not call this. Operators run the CLI or
 * `.github/workflows/teams-org-migrated-audit-backfill.yml`.
 */

const defaultWranglerConfigPath = 'packages/worker/wrangler.jsonc'

export const productionBackfillConfirm = 'backfill org.migrated audit'

export const backfillModes = ['dry-run', 'apply'] as const
export type BackfillMode = (typeof backfillModes)[number]

export type BackfillTarget =
	| { kind: 'production' }
	| { kind: 'preview'; workerName: string }

const previewWorkerNamePattern =
	/^kody-(?:pr-\d+|branch-[a-z0-9]+(?:-[a-z0-9]+)*)$/

export type OrgMigratedAuditBoundStatement = {
	all: <Row>() => Promise<{ results?: Array<Row> }>
	first: <Row>() => Promise<Row | null>
	run: () => Promise<unknown>
}

export type OrgMigratedAuditDatabase = {
	prepare: (sql: string) => OrgMigratedAuditBoundStatement & {
		bind: (
			...values: ReadonlyArray<string | null>
		) => OrgMigratedAuditBoundStatement
	}
}

export type OrgMigratedAuditBackfillResult = {
	dryRun: boolean
	orgs: number
	/** Orgs that do not yet have an `org.migrated` success row. */
	pending: number
	/** Orgs that already have an `org.migrated` success row. */
	present: number
	/** Rows written on this run. Always 0 for dry-run. */
	inserted: number
}

const usage = [
	'Usage: node tools/teams-migration/backfill-org-migrated-audit.ts --target <production|kody-pr-<number>|kody-branch-<slug>> --mode <dry-run|apply> [--confirm "backfill org.migrated audit"]',
	'',
	'dry-run  Print orgs, pending, present, and inserted=0. Writes nothing.',
	'apply    Insert the missing org.migrated success rows. A repeat inserts nothing.',
	'',
	'Production (either mode) requires --confirm "backfill org.migrated audit".',
	'Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.',
	'Deploy does not run this command.',
].join('\n')

export function parseBackfillTarget(value: string): BackfillTarget {
	if (value === 'production') return { kind: 'production' }
	if (!previewWorkerNamePattern.test(value)) {
		throw new Error(
			`target must be production, kody-pr-<number>, or kody-branch-<slug>, got ${JSON.stringify(value)}.`,
		)
	}
	return { kind: 'preview', workerName: value }
}

export function parseBackfillMode(value: string): BackfillMode {
	switch (value) {
		case 'dry-run':
		case 'apply':
			return value
		default:
			throw new Error(`--mode must be ${backfillModes.join(' or ')}.`)
	}
}

export function assertProductionBackfillConfirm(input: {
	target: BackfillTarget
	confirm: string | undefined
}) {
	switch (input.target.kind) {
		case 'preview':
			return
		case 'production':
			if (input.confirm !== productionBackfillConfirm) {
				throw new Error(
					`Production needs --confirm "${productionBackfillConfirm}".`,
				)
			}
			return
		default: {
			const exhaustive: never = input.target
			throw new Error(`Unknown backfill target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

export function parseBackfillArgs(argv: ReadonlyArray<string>) {
	const known = new Set(['--target', '--mode', '--confirm'])
	const seen = new Set<string>()
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? ''
		if (!arg.startsWith('--')) {
			throw new Error(`Unexpected argument ${arg}.\n${usage}`)
		}
		if (!known.has(arg)) throw new Error(`Unknown flag ${arg}.\n${usage}`)
		if (seen.has(arg)) throw new Error(`Duplicate flag ${arg}.\n${usage}`)
		seen.add(arg)
		const value = argv[index + 1]
		if (!value || value.startsWith('--')) {
			throw new Error(`Missing ${arg} <value>.\n${usage}`)
		}
		index += 1
	}
	if (!seen.has('--target')) throw new Error(`Missing --target.\n${usage}`)
	if (!seen.has('--mode')) throw new Error(`Missing --mode.\n${usage}`)
	const target = parseBackfillTarget(readFlag(argv, '--target'))
	const mode = parseBackfillMode(readFlag(argv, '--mode'))
	const confirm = seen.has('--confirm')
		? readFlag(argv, '--confirm')
		: undefined
	return { target, mode, confirm }
}

function readFlag(argv: ReadonlyArray<string>, flag: string) {
	const value = argv[argv.indexOf(flag) + 1]
	if (!value) throw new Error(`Missing ${flag} <value>.\n${usage}`)
	return value
}

type WranglerD1Config = {
	env?: {
		production?: {
			d1_databases?: Array<{ binding?: unknown; database_name?: unknown }>
		}
	}
}

export async function readProductionD1BindingNames(
	wranglerPath = defaultWranglerConfigPath,
) {
	const config = parseJsonc<WranglerD1Config>(
		await readFile(wranglerPath, 'utf8'),
	)
	const databases = config.env?.production?.d1_databases
	if (!databases) {
		throw new Error(`${wranglerPath} is missing env.production.d1_databases.`)
	}
	return {
		appD1Name: requiredDatabaseName(databases, 'APP_DB', wranglerPath),
		auditD1Name: requiredDatabaseName(databases, 'AUDIT_DB', wranglerPath),
	}
}

function requiredDatabaseName(
	databases: Array<{ binding?: unknown; database_name?: unknown }>,
	binding: string,
	wranglerPath: string,
) {
	const name = databases.find(
		(entry) => entry.binding === binding,
	)?.database_name
	if (typeof name !== 'string' || name.length === 0) {
		throw new Error(
			`${wranglerPath} is missing database_name for production ${binding}.`,
		)
	}
	return name
}

export function previewBackfillDatabaseNames(workerName: string) {
	parseBackfillTarget(workerName)
	const names = buildPreviewResourceNames(workerName)
	assertPreviewD1Name(names.d1DatabaseName)
	assertPreviewD1Name(names.auditD1DatabaseName)
	return {
		appD1Name: names.d1DatabaseName,
		auditD1Name: names.auditD1DatabaseName,
	}
}

function assertPreviewD1Name(name: string) {
	if (!previewResourceNamePattern.test(name)) {
		throw new Error(
			`Refusing preview D1 "${name}": it does not match the preview resource naming scheme.`,
		)
	}
}

export async function resolveBackfillDatabaseNames(
	target: BackfillTarget,
	wranglerPath = defaultWranglerConfigPath,
) {
	switch (target.kind) {
		case 'production':
			return readProductionD1BindingNames(wranglerPath)
		case 'preview':
			return previewBackfillDatabaseNames(target.workerName)
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown backfill target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

export function createD1HttpDatabase(
	client: CloudflareClient,
	uuid: string,
): OrgMigratedAuditDatabase {
	return {
		prepare(sql: string) {
			let params: Array<string | null> = []
			const statement = {
				bind(...values: Array<string | null>) {
					params = values
					return statement
				},
				async all<Row>() {
					const results = await queryD1<Row>(client, uuid, sql, params)
					return { results }
				},
				async first<Row>() {
					const results = await queryD1<Row>(client, uuid, sql, params)
					return results[0] ?? null
				},
				async run() {
					const changes = await queryD1Changes(client, uuid, sql, params)
					return { meta: { changes } }
				},
			}
			return statement
		},
	}
}

function changesFromRun(result: unknown) {
	const meta =
		result &&
		typeof result === 'object' &&
		'meta' in result &&
		result.meta &&
		typeof result.meta === 'object'
			? result.meta
			: null
	const changes = meta && 'changes' in meta ? meta.changes : undefined
	if (
		typeof changes !== 'number' ||
		!Number.isInteger(changes) ||
		changes < 0
	) {
		throw new Error('D1 insert did not report changes.')
	}
	return changes
}

function orgIdsFromRows(rows: Array<{ id?: unknown }> | undefined) {
	return (rows ?? []).map((row) => {
		if (typeof row.id !== 'string' || row.id.length === 0) {
			throw new Error('orgs.id must be a non-empty string.')
		}
		return row.id
	})
}

export async function backfillOrgMigratedAuditEvents(input: {
	appDb: OrgMigratedAuditDatabase
	auditDb: OrgMigratedAuditDatabase
	now?: () => string
	dryRun?: boolean
}): Promise<OrgMigratedAuditBackfillResult> {
	const dryRun = input.dryRun === true
	const now = input.now ?? (() => new Date().toISOString())
	const orgs = await input.appDb
		.prepare(`SELECT id FROM orgs`)
		.all<{ id: string }>()
	const orgIds = orgIdsFromRows(orgs.results)
	if (orgIds.length === 0) {
		return { dryRun, orgs: 0, pending: 0, present: 0, inserted: 0 }
	}

	let pending = 0
	let present = 0
	let inserted = 0
	for (const orgId of orgIds) {
		const existing = await input.auditDb
			.prepare(
				`SELECT id FROM org_audit_events
				 WHERE org_id = ? AND action = 'org.migrated' AND result = 'success'
				 LIMIT 1`,
			)
			.bind(orgId)
			.first<{ id: string }>()
		if (existing) {
			present += 1
			continue
		}
		if (dryRun) {
			pending += 1
			continue
		}
		// One statement so a concurrent apply cannot insert a second success
		// row. 0003 also rejects that duplicate at the database.
		const written = await input.auditDb
			.prepare(
				`INSERT INTO org_audit_events (
					id, org_id, actor_user_id, actor_username, credential_kind,
					credential_id, action, resource_type, resource_id, target_user_id,
					result, details_json, ip_hash, created_at
				)
				SELECT ?, ?, NULL, NULL, NULL, NULL, 'org.migrated', 'org', ?, NULL, 'success', NULL, NULL, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM org_audit_events
					WHERE org_id = ? AND action = 'org.migrated' AND result = 'success'
				)`,
			)
			.bind(randomUUID(), orgId, orgId, now(), orgId)
			.run()
		const changes = changesFromRun(written)
		if (changes === 0) {
			present += 1
			continue
		}
		if (changes !== 1) {
			throw new Error(
				`org.migrated insert wrote ${String(changes)} rows for one org.`,
			)
		}
		pending += 1
		inserted += 1
	}
	return { dryRun, orgs: orgIds.length, pending, present, inserted }
}

export function formatBackfillReport(input: {
	target: string
	appD1Name: string
	auditD1Name: string
	result: OrgMigratedAuditBackfillResult
}) {
	const mode = input.result.dryRun ? 'dry-run' : 'apply'
	return [
		'org.migrated audit backfill',
		`mode=${mode}`,
		`target=${input.target}`,
		`app_db=${input.appD1Name}`,
		`audit_db=${input.auditD1Name}`,
		`orgs=${String(input.result.orgs)}`,
		`pending=${String(input.result.pending)}`,
		`present=${String(input.result.present)}`,
		`inserted=${String(input.result.inserted)}`,
	].join('\n')
}

export function backfillTargetLabel(target: BackfillTarget) {
	switch (target.kind) {
		case 'production':
			return 'production'
		case 'preview':
			return target.workerName
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown backfill target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

export async function runOrgMigratedAuditBackfill(input: {
	client: CloudflareClient
	target: BackfillTarget
	mode: BackfillMode
	confirm?: string
	wranglerPath?: string
	now?: () => string
}) {
	assertProductionBackfillConfirm({
		target: input.target,
		confirm: input.confirm,
	})
	const names = await resolveBackfillDatabaseNames(
		input.target,
		input.wranglerPath,
	)
	const appUuid = await resolveD1Uuid(input.client, names.appD1Name)
	const auditUuid = await resolveD1Uuid(input.client, names.auditD1Name)
	const result = await backfillOrgMigratedAuditEvents({
		appDb: createD1HttpDatabase(input.client, appUuid),
		auditDb: createD1HttpDatabase(input.client, auditUuid),
		dryRun: input.mode === 'dry-run',
		now: input.now,
	})
	return { ...names, result }
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`${name} is required.\n${usage}`)
	return value
}

async function main() {
	const args = parseBackfillArgs(process.argv.slice(2))
	const report = await runOrgMigratedAuditBackfill({
		client: {
			accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
			apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
		},
		target: args.target,
		mode: args.mode,
		confirm: args.confirm,
	})
	console.log(
		formatBackfillReport({
			target: backfillTargetLabel(args.target),
			appD1Name: report.appD1Name,
			auditD1Name: report.auditD1Name,
			result: report.result,
		}),
	)
}

if (isExecutedDirectly(import.meta.url)) {
	try {
		await main()
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}
}
