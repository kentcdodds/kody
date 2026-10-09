import { expect, test } from 'vitest'
import {
	assertRehearsalWorkerName,
	formatD1SnapshotMarkdown,
	parseD1RehearsalSnapshot,
	rehearsalDatabaseNames,
	restoreD1RehearsalSnapshot,
	takeD1RehearsalSnapshot,
} from './d1-rehearsal.ts'

type FakeDatabase = {
	uuid: string
	bookmark: string
	tables: Record<string, number>
}

function fakeD1Api(databases: Record<string, FakeDatabase>) {
	const requests: Array<string> = []
	const restores: Array<{ uuid: string; bookmark: string }> = []
	const ok = (result: unknown) => Response.json({ success: true, result })
	const byUuid = (uuid: string) =>
		Object.values(databases).find((database) => database.uuid === uuid)
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/d1\/database/, '')
		requests.push(`${method} ${path}${url.search}`)
		if (path === '' && method === 'GET') {
			const name = url.searchParams.get('name') ?? ''
			const database = databases[name]
			return ok(database ? [{ name, uuid: database.uuid }] : [])
		}
		const [, uuid = '', ...rest] = path.split('/')
		const database = byUuid(uuid)
		if (!database) throw new Error(`unknown database ${uuid}`)
		const action = rest.join('/')
		if (action === 'time_travel/bookmark') {
			return ok({ bookmark: database.bookmark })
		}
		if (action === 'time_travel/restore' && method === 'POST') {
			const bookmark = url.searchParams.get('bookmark') ?? ''
			restores.push({ uuid, bookmark })
			return ok({
				bookmark,
				previous_bookmark: database.bookmark,
				message: 'ok',
			})
		}
		if (action === 'query' && method === 'POST') {
			const sql = String(JSON.parse(String(init?.body)).sql)
			if (sql.startsWith('SELECT name FROM sqlite_master')) {
				return ok([
					{
						results: Object.keys(database.tables).map((name) => ({ name })),
					},
				])
			}
			if (sql.includes('UNION')) {
				return Response.json(
					{
						success: false,
						errors: [{ message: 'too many terms in compound SELECT' }],
					},
					{ status: 400 },
				)
			}
			const counted = [...sql.matchAll(/SELECT '([^']+)' AS table_name/g)].map(
				(match) => match[1] ?? '',
			)
			return ok(
				counted.map((table) => ({
					results: [{ table_name: table, row_count: database.tables[table] }],
				})),
			)
		}
		throw new Error(`unexpected ${method} ${url.pathname}`)
	}
	return { fetcher, requests, restores }
}

const client = (fetcher: typeof fetch) => ({
	accountId: 'acct',
	apiToken: 'token',
	fetcher,
	sleep: async () => {},
})

const worker = 'kody-branch-teams-rehearsal'

function fixtureDatabases() {
	return {
		[`${worker}-db`]: {
			uuid: 'app-uuid',
			bookmark: 'app-b1',
			tables: { users: 5, saved_packages: 7, d1_migrations: 83 },
		},
		[`${worker}-audit-db`]: {
			uuid: 'audit-uuid',
			bookmark: 'audit-b1',
			tables: { audit_events: 12 },
		},
		[`${worker}-jobs-db`]: {
			uuid: 'jobs-uuid',
			bookmark: 'jobs-b1',
			tables: { jobs: 3 },
		},
	}
}

test('rehearsals refuse PR previews, production, and non-preview names', () => {
	for (const name of [
		'kody',
		'kody-pr-12',
		'kody-platform',
		'kody-branch-',
		'x',
	]) {
		expect(() => assertRehearsalWorkerName(name)).toThrow(
			'rehearsals run only on branch previews',
		)
	}
	expect(rehearsalDatabaseNames(worker)).toEqual({
		app: `${worker}-db`,
		audit: `${worker}-audit-db`,
		jobs: `${worker}-jobs-db`,
	})
})

test('snapshot records a bookmark and sorted per-table row counts for app, audit, and jobs D1', async () => {
	const api = fakeD1Api(fixtureDatabases())
	const snapshot = await takeD1RehearsalSnapshot(
		client(api.fetcher),
		worker,
		() => new Date('2026-10-08T00:00:00Z'),
	)
	expect(snapshot).toEqual({
		version: 1,
		workerName: worker,
		takenAt: '2026-10-08T00:00:00.000Z',
		databases: [
			{
				role: 'app',
				name: `${worker}-db`,
				uuid: 'app-uuid',
				bookmark: 'app-b1',
				tables: [
					{ table: 'd1_migrations', rows: 83 },
					{ table: 'saved_packages', rows: 7 },
					{ table: 'users', rows: 5 },
				],
			},
			{
				role: 'audit',
				name: `${worker}-audit-db`,
				uuid: 'audit-uuid',
				bookmark: 'audit-b1',
				tables: [{ table: 'audit_events', rows: 12 }],
			},
			{
				role: 'jobs',
				name: `${worker}-jobs-db`,
				uuid: 'jobs-uuid',
				bookmark: 'jobs-b1',
				tables: [{ table: 'jobs', rows: 3 }],
			},
		],
	})
	expect(parseD1RehearsalSnapshot(JSON.stringify(snapshot))).toEqual(snapshot)
	const [first] = snapshot.databases
	expect(() =>
		parseD1RehearsalSnapshot(
			JSON.stringify({
				...snapshot,
				databases: [{ ...first, tables: undefined }],
			}),
		),
	).toThrow('malformed database entry')
	expect(() =>
		parseD1RehearsalSnapshot(
			JSON.stringify({ ...snapshot, databases: [first, first] }),
		),
	).toThrow('duplicate database roles')
	const markdown = formatD1SnapshotMarkdown(snapshot)
	expect(markdown).toContain(`| \`${worker}-jobs-db\` | jobs | \`jobs-b1\` |`)
	expect(markdown).toContain('app: 3 tables, 95 rows')
})

test('restore replays each recorded bookmark and refuses a foreign or recreated database', async () => {
	const databases = fixtureDatabases()
	const api = fakeD1Api(databases)
	const snapshot = await takeD1RehearsalSnapshot(client(api.fetcher), worker)

	const results = await restoreD1RehearsalSnapshot(
		client(api.fetcher),
		worker,
		snapshot,
	)
	expect(api.restores).toEqual([
		{ uuid: 'app-uuid', bookmark: 'app-b1' },
		{ uuid: 'audit-uuid', bookmark: 'audit-b1' },
		{ uuid: 'jobs-uuid', bookmark: 'jobs-b1' },
	])
	expect(results.map((result) => result.restoredTo)).toEqual([
		'app-b1',
		'audit-b1',
		'jobs-b1',
	])

	await expect(
		restoreD1RehearsalSnapshot(
			client(api.fetcher),
			'kody-branch-other',
			snapshot,
		),
	).rejects.toThrow(`Snapshot belongs to ${worker}, not kody-branch-other.`)

	databases[`${worker}-jobs-db`].uuid = 'jobs-uuid-new'
	api.restores.length = 0
	await expect(
		restoreD1RehearsalSnapshot(client(api.fetcher), worker, snapshot),
	).rejects.toThrow('was recreated since the snapshot')
	expect(api.restores).toEqual([])
})

test('snapshot fails loudly when a preview database is missing', async () => {
	const databases: Record<string, FakeDatabase> = fixtureDatabases()
	delete databases[`${worker}-jobs-db`]
	const api = fakeD1Api(databases)
	await expect(
		takeD1RehearsalSnapshot(client(api.fetcher), worker),
	).rejects.toThrow(`D1 database ${worker}-jobs-db (jobs) does not exist`)
})
