import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, test } from 'vitest'
import { type CloudflareClient } from '../preview-rehearsal/d1-rehearsal.ts'
import {
	assertProductionBackfillConfirm,
	backfillOrgMigratedAuditEvents,
	formatBackfillReport,
	parseBackfillArgs,
	parseBackfillTarget,
	previewBackfillDatabaseNames,
	productionBackfillConfirm,
	readProductionD1BindingNames,
	runOrgMigratedAuditBackfill,
	type OrgMigratedAuditDatabase,
} from './backfill-org-migrated-audit.ts'

function sqliteDatabase(sqlite: DatabaseSync): OrgMigratedAuditDatabase {
	return {
		prepare(sql: string) {
			const bound = (params: Array<SQLInputValue>) => ({
				all<Row>() {
					const results = sqlite.prepare(sql).all(...params) as Row[]
					return Promise.resolve({ results })
				},
				first<Row>() {
					const row = sqlite.prepare(sql).get(...params) as Row | undefined
					return Promise.resolve(row ?? null)
				},
				async run() {
					sqlite.prepare(sql).run(...params)
					return { success: true }
				},
			})
			return {
				...bound([]),
				bind(...values: Array<string | null>) {
					return bound(values)
				},
			}
		},
	}
}

function createDatabases() {
	const app = new DatabaseSync(':memory:')
	const audit = new DatabaseSync(':memory:')
	app.exec(`CREATE TABLE orgs (id TEXT PRIMARY KEY NOT NULL)`)
	audit.exec(`CREATE TABLE org_audit_events (
		id TEXT PRIMARY KEY NOT NULL,
		org_id TEXT NOT NULL,
		actor_user_id TEXT,
		actor_username TEXT,
		credential_kind TEXT,
		credential_id TEXT,
		action TEXT NOT NULL,
		resource_type TEXT,
		resource_id TEXT,
		target_user_id TEXT,
		result TEXT NOT NULL,
		details_json TEXT,
		ip_hash TEXT,
		created_at TEXT NOT NULL
	)`)
	return {
		app,
		audit,
		appDb: sqliteDatabase(app),
		auditDb: sqliteDatabase(audit),
	}
}

const fixedNow = () => '2026-10-10T00:00:00.000Z'

test('dry-run prints the pending count and writes nothing', async () => {
	const { app, audit, appDb, auditDb } = createDatabases()
	app.prepare(`INSERT INTO orgs (id) VALUES (?)`).run('org-a')
	app.prepare(`INSERT INTO orgs (id) VALUES (?)`).run('org-b')
	const result = await backfillOrgMigratedAuditEvents({
		appDb,
		auditDb,
		dryRun: true,
		now: fixedNow,
	})
	expect(result).toEqual({
		dryRun: true,
		orgs: 2,
		pending: 2,
		present: 0,
		inserted: 0,
	})
	expect(
		audit.prepare(`SELECT COUNT(*) AS n FROM org_audit_events`).get(),
	).toEqual({ n: 0 })
})

test('apply is idempotent and ignores a non-success org.migrated row', async () => {
	const { app, audit, appDb, auditDb } = createDatabases()
	app.prepare(`INSERT INTO orgs (id) VALUES (?)`).run('org-a')
	app.prepare(`INSERT INTO orgs (id) VALUES (?)`).run('org-b')
	audit
		.prepare(
			`INSERT INTO org_audit_events (
				id, org_id, actor_user_id, actor_username, credential_kind,
				credential_id, action, resource_type, resource_id, target_user_id,
				result, details_json, ip_hash, created_at
			) VALUES (?, ?, NULL, NULL, NULL, NULL, 'org.migrated', 'org', ?, NULL, 'failure', NULL, NULL, ?)`,
		)
		.run('existing', 'org-a', 'org-a', '2026-01-01T00:00:00.000Z')

	const first = await backfillOrgMigratedAuditEvents({
		appDb,
		auditDb,
		now: fixedNow,
	})
	expect(first).toEqual({
		dryRun: false,
		orgs: 2,
		pending: 2,
		present: 0,
		inserted: 2,
	})
	const rows = audit
		.prepare(
			`SELECT org_id, action, resource_type, resource_id, result, created_at
			 FROM org_audit_events
			 WHERE result = 'success'
			 ORDER BY org_id`,
		)
		.all()
	expect(rows).toEqual([
		{
			org_id: 'org-a',
			action: 'org.migrated',
			resource_type: 'org',
			resource_id: 'org-a',
			result: 'success',
			created_at: '2026-10-10T00:00:00.000Z',
		},
		{
			org_id: 'org-b',
			action: 'org.migrated',
			resource_type: 'org',
			resource_id: 'org-b',
			result: 'success',
			created_at: '2026-10-10T00:00:00.000Z',
		},
	])

	const second = await backfillOrgMigratedAuditEvents({
		appDb,
		auditDb,
		now: () => '2026-10-11T00:00:00.000Z',
	})
	expect(second).toEqual({
		dryRun: false,
		orgs: 2,
		pending: 0,
		present: 2,
		inserted: 0,
	})
	expect(
		audit.prepare(`SELECT COUNT(*) AS n FROM org_audit_events`).get(),
	).toEqual({ n: 3 })
})

test('an empty org list does not touch AUDIT_DB', async () => {
	const { appDb } = createDatabases()
	const auditDb: OrgMigratedAuditDatabase = {
		prepare() {
			throw new Error('AUDIT_DB should not be queried')
		},
	}
	await expect(
		backfillOrgMigratedAuditEvents({ appDb, auditDb, dryRun: true }),
	).resolves.toEqual({
		dryRun: true,
		orgs: 0,
		pending: 0,
		present: 0,
		inserted: 0,
	})
})

test('a blank orgs.id fails loudly', async () => {
	const { app, appDb, auditDb } = createDatabases()
	app.prepare(`INSERT INTO orgs (id) VALUES (?)`).run('')
	await expect(
		backfillOrgMigratedAuditEvents({ appDb, auditDb }),
	).rejects.toThrow('orgs.id must be a non-empty string.')
})

test('parseBackfillTarget accepts preview workers and rejects production names', () => {
	expect(parseBackfillTarget('production')).toEqual({ kind: 'production' })
	expect(parseBackfillTarget('kody-pr-42')).toEqual({
		kind: 'preview',
		workerName: 'kody-pr-42',
	})
	expect(parseBackfillTarget('kody-branch-org-migrated-audit')).toEqual({
		kind: 'preview',
		workerName: 'kody-branch-org-migrated-audit',
	})
	for (const value of ['kody', 'kody-audit', 'kody-preview', 'kody-pr-42-db']) {
		expect(() => parseBackfillTarget(value)).toThrow(/target must be/)
	}
})

test('production requires the confirm phrase and preview does not', () => {
	expect(() =>
		assertProductionBackfillConfirm({
			target: { kind: 'production' },
			confirm: undefined,
		}),
	).toThrow(productionBackfillConfirm)
	expect(() =>
		assertProductionBackfillConfirm({
			target: { kind: 'production' },
			confirm: productionBackfillConfirm,
		}),
	).not.toThrow()
	expect(() =>
		assertProductionBackfillConfirm({
			target: { kind: 'preview', workerName: 'kody-pr-1' },
			confirm: undefined,
		}),
	).not.toThrow()
})

test('parseBackfillArgs rejects unknown flags and a missing mode', () => {
	expect(
		parseBackfillArgs(['--target', 'kody-pr-7', '--mode', 'dry-run']),
	).toEqual({
		target: { kind: 'preview', workerName: 'kody-pr-7' },
		mode: 'dry-run',
		confirm: undefined,
	})
	expect(() => parseBackfillArgs(['--target', 'production'])).toThrow(
		/Missing --mode/,
	)
	expect(() =>
		parseBackfillArgs(['--target', 'kody-pr-1', '--mode', 'apply', '--force']),
	).toThrow(/Unknown flag/)
})

test('preview database names stay on the preview naming scheme', () => {
	expect(previewBackfillDatabaseNames('kody-pr-42')).toEqual({
		appD1Name: 'kody-pr-42-db',
		auditD1Name: 'kody-pr-42-audit-db',
	})
})

test('production binding names come from wrangler env.production', async () => {
	await expect(readProductionD1BindingNames()).resolves.toEqual({
		appD1Name: 'kody',
		auditD1Name: 'kody-audit',
	})
})

type Memory = {
	orgs: Array<string>
	events: Array<{ orgId: string; result: string }>
	queries: Array<{
		database: string
		sql: string
		params: Array<string | null>
	}>
}

function memoryClient(memory: Memory): CloudflareClient {
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url,
		)
		if (
			url.pathname.endsWith('/d1/database') &&
			(init?.method ?? 'GET') === 'GET'
		) {
			const name = url.searchParams.get('name') ?? ''
			return Response.json({
				success: true,
				result: [{ uuid: `uuid-${name}`, name }],
			})
		}
		const match = /\/d1\/database\/uuid-(?<name>[^/]+)\/query$/.exec(
			url.pathname,
		)
		if (!match?.groups?.name || init?.method !== 'POST') {
			return Response.json(
				{ success: false, errors: [{ message: `unexpected ${url.pathname}` }] },
				{ status: 400 },
			)
		}
		const database = match.groups.name
		const body = JSON.parse(String(init.body)) as {
			sql: string
			params?: Array<string | null>
		}
		const sql = body.sql.replace(/\s+/g, ' ').trim()
		const params = body.params ?? []
		memory.queries.push({ database, sql, params })
		if (sql === 'SELECT id FROM orgs') {
			return Response.json({
				success: true,
				result: [{ results: memory.orgs.map((id) => ({ id })) }],
			})
		}
		if (sql.startsWith('SELECT id FROM org_audit_events')) {
			const orgId = params[0]
			const hit = memory.events.find(
				(event) => event.orgId === orgId && event.result === 'success',
			)
			return Response.json({
				success: true,
				result: [{ results: hit ? [{ id: 'existing' }] : [] }],
			})
		}
		if (sql.startsWith('INSERT INTO org_audit_events')) {
			const orgId = params[1]
			if (typeof orgId !== 'string' || sql.includes(orgId)) {
				return Response.json(
					{
						success: false,
						errors: [{ message: 'org id must be a bound parameter' }],
					},
					{ status: 400 },
				)
			}
			memory.events.push({ orgId, result: 'success' })
			return Response.json({ success: true, result: [{ results: [] }] })
		}
		return Response.json(
			{ success: false, errors: [{ message: `unexpected sql ${sql}` }] },
			{ status: 400 },
		)
	}
	return {
		accountId: 'account',
		apiToken: 'token',
		apiBaseUrl: 'https://example.test/client/v4',
		fetcher,
	}
}

test('dry-run then apply then apply hits preview databases and inserts once', async () => {
	const memory: Memory = {
		orgs: ['org-a', 'org-b'],
		events: [],
		queries: [],
	}
	const client = memoryClient(memory)
	const target = parseBackfillTarget('kody-pr-7')
	const dry = await runOrgMigratedAuditBackfill({
		client,
		target,
		mode: 'dry-run',
		now: fixedNow,
	})
	expect(dry).toMatchObject({
		appD1Name: 'kody-pr-7-db',
		auditD1Name: 'kody-pr-7-audit-db',
		result: { dryRun: true, orgs: 2, pending: 2, present: 0, inserted: 0 },
	})
	expect(memory.events).toEqual([])
	expect(memory.queries.some((query) => query.sql.startsWith('INSERT'))).toBe(
		false,
	)

	const applied = await runOrgMigratedAuditBackfill({
		client,
		target,
		mode: 'apply',
		now: fixedNow,
	})
	expect(applied.result).toEqual({
		dryRun: false,
		orgs: 2,
		pending: 2,
		present: 0,
		inserted: 2,
	})
	expect(memory.events.map((event) => event.orgId).sort()).toEqual([
		'org-a',
		'org-b',
	])
	const insert = memory.queries.find((query) => query.sql.startsWith('INSERT'))
	expect(insert?.database).toBe('kody-pr-7-audit-db')
	expect(insert?.params[1]).toBe('org-a')
	expect(
		memory.queries.some((query) => query.database === 'kody-pr-7-db'),
	).toBe(true)

	const again = await runOrgMigratedAuditBackfill({
		client,
		target,
		mode: 'apply',
		now: fixedNow,
	})
	expect(again.result.inserted).toBe(0)
	expect(again.result.pending).toBe(0)
	expect(again.result.present).toBe(2)
	expect(memory.events).toHaveLength(2)
})

test('confirmed production dry-run reads kody and kody-audit and writes nothing', async () => {
	const memory: Memory = {
		orgs: ['org-a'],
		events: [],
		queries: [],
	}
	const report = await runOrgMigratedAuditBackfill({
		client: memoryClient(memory),
		target: { kind: 'production' },
		mode: 'dry-run',
		confirm: productionBackfillConfirm,
		now: fixedNow,
	})
	expect(report.appD1Name).toBe('kody')
	expect(report.auditD1Name).toBe('kody-audit')
	expect(report.result).toEqual({
		dryRun: true,
		orgs: 1,
		pending: 1,
		present: 0,
		inserted: 0,
	})
	expect(new Set(memory.queries.map((query) => query.database))).toEqual(
		new Set(['kody', 'kody-audit']),
	)
	expect(memory.queries.some((query) => query.sql.startsWith('INSERT'))).toBe(
		false,
	)
	expect(memory.events).toEqual([])
})

test('production dry-run refuses to call Cloudflare without the confirm phrase', async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error('Cloudflare should not be called')
	}
	await expect(
		runOrgMigratedAuditBackfill({
			client: {
				accountId: 'account',
				apiToken: 'token',
				apiBaseUrl: 'https://example.test/client/v4',
				fetcher,
			},
			target: { kind: 'production' },
			mode: 'dry-run',
		}),
	).rejects.toThrow(productionBackfillConfirm)
})

test('the report is counts and database names', () => {
	expect(
		formatBackfillReport({
			target: 'kody-pr-7',
			appD1Name: 'kody-pr-7-db',
			auditD1Name: 'kody-pr-7-audit-db',
			result: {
				dryRun: true,
				orgs: 2,
				pending: 2,
				present: 0,
				inserted: 0,
			},
		}),
	).toBe(
		[
			'org.migrated audit backfill',
			'mode=dry-run',
			'target=kody-pr-7',
			'app_db=kody-pr-7-db',
			'audit_db=kody-pr-7-audit-db',
			'orgs=2',
			'pending=2',
			'present=0',
			'inserted=0',
		].join('\n'),
	)
})
