import { buildPackageJobId } from '@kody-internal/shared/jobs/package-job-id.ts'
import { type JobRow } from '@kody-internal/shared/jobs/repo.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	decryptSecretValue,
	decryptUserOauthAccessToken,
	decryptUserOauthClientSecret,
	decryptUserOauthRefreshToken,
	decryptWebhookHmacSecret,
	decryptWebhookUrlSecret,
	encryptSecretValue,
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	encryptWebhookHmacSecret,
	encryptWebhookUrlSecret,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
	userSecretContext,
	userWebhookHmacSecretContext,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import {
	orgAuditOutboxInsertStatement,
	planOrgAuditOutbox,
} from '#worker/orgs/org-audit-outbox.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	type OrgTransferEffects,
	OrgTransferRefusedError,
	runOrgResourceTransfer,
} from './apply.ts'
import { resealOrgTransferSecrets } from './reencrypt.ts'
import { loadOrgTransferSnapshot } from './snapshot.ts'

const jobsMock = vi.hoisted(() => ({ jobs: [] as Array<unknown> }))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsForUser: async () => jobsMock.jobs,
	}),
}))

const env = { SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum' }
const src = 'org-src' as OwnerId
const dst = 'org-dst' as OwnerId
const pkgA = '11111111-1111-4111-8111-111111111111'
const pkgB = '22222222-2222-4222-8222-222222222222'
const pkgC = '33333333-3333-4333-8333-333333333333'
const goneOrphanPkg = '44444444-4444-4444-8444-444444444444'
const now = '2026-10-11T00:00:00.000Z'

const plaintexts = {
	userSecret: 'user-secret-plaintext-value',
	packageSecret: 'package-secret-plaintext-value',
	clientSecret: 'oauth-client-secret-plaintext',
	accessToken: 'integration-access-token-plaintext',
	refreshToken: 'integration-refresh-token-plaintext',
	webhookUrl: 'webhook-url-secret-plaintext',
	webhookHmac: 'webhook-hmac-secret-plaintext',
}

beforeEach(() => {
	jobsMock.jobs = []
})

async function seed() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const run = (sql: string, ...params: Array<string | number | null>) =>
		sqlite.prepare(sql).run(...params)
	for (const [id, slug] of [
		[src, 'bradhave'],
		[dst, 'haveman'],
	]) {
		run(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)`,
			id!,
			slug!,
			now,
			now,
		)
	}
	run(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, 'person-brad', 'owner', ?)`,
		dst,
		now,
	)
	for (const [id, kodyId] of [
		[pkgA, 'alpha'],
		[pkgB, 'beta'],
		[pkgC, 'gamma'],
	] as const) {
		run(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, ?, ?, 'desc', ?)`,
			id,
			src,
			`@bradhave/${kodyId}`,
			kodyId,
			`src-${kodyId}`,
		)
		run(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, published_commit, created_at, updated_at)
			 VALUES (?, ?, 'package', ?, ?, 'commit-1', ?, ?)`,
			`src-${kodyId}`,
			src,
			id,
			`repo-${kodyId}`,
			now,
			now,
		)
	}
	// Orphan source of a package that no longer exists.
	run(
		`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, created_at, updated_at)
		 VALUES ('src-orphan', ?, 'package', 'missing-package', 'repo-orphan', ?, ?)`,
		src,
		now,
		now,
	)

	run(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('bucket-user', ?, 'user', '')`,
		src,
	)
	run(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('bucket-pkg-a', ?, 'package', ?)`,
		src,
		pkgA,
	)
	run(
		`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bucket-user', 'API_KEY', ?)`,
		await encryptSecretValue(
			env,
			plaintexts.userSecret,
			userSecretContext(src),
		),
	)
	run(
		`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bucket-pkg-a', 'PKG_TOKEN', ?)`,
		await encryptSecretValue(
			env,
			plaintexts.packageSecret,
			userSecretContext(src),
		),
	)

	run(
		`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow, client_secret_encrypted, logo_key)
		 VALUES (?, 'myapp', 'github', 'client-1', 'https://example.com/token', 'confidential', ?, ?)`,
		src,
		await encryptUserOauthClientSecret(
			env,
			plaintexts.clientSecret,
			userOauthAppCredentialContext(src, 'myapp'),
		),
		`user-oauth-app-logos/${src}/myapp.png`,
	)
	run(
		`INSERT INTO user_integrations (user_id, name, app_slug, access_token_encrypted, refresh_token_encrypted)
		 VALUES (?, 'github', 'myapp', ?, ?)`,
		src,
		await encryptUserOauthAccessToken(
			env,
			plaintexts.accessToken,
			userIntegrationCredentialContext(src, 'github'),
		),
		await encryptUserOauthRefreshToken(
			env,
			plaintexts.refreshToken,
			userIntegrationCredentialContext(src, 'github'),
		),
	)

	run(
		`INSERT INTO webhook_endpoints (id, user_id, package_id, webhook_name, url_secret_hash, created_at, rotated_at, url_secret_encrypted, hmac_secret_encrypted)
		 VALUES ('hook-1', ?, ?, 'ping', 'hash-1', ?, ?, ?, ?)`,
		src,
		pkgA,
		now,
		now,
		await encryptWebhookUrlSecret(
			env,
			plaintexts.webhookUrl,
			userWebhookUrlSecretContext(src, 'hook-1'),
		),
		await encryptWebhookHmacSecret(
			env,
			plaintexts.webhookHmac,
			userWebhookHmacSecretContext(src, 'hook-1'),
		),
	)
	// Disabled webhook of a deleted package.
	run(
		`INSERT INTO webhook_endpoints (id, user_id, package_id, webhook_name, url_secret_hash, enabled, created_at, rotated_at)
		 VALUES ('hook-orphan', ?, ?, 'ping', 'hash-2', 0, ?, ?)`,
		src,
		goneOrphanPkg,
		now,
		now,
	)

	run(
		`INSERT INTO mcp_memories (id, user_id, subject, summary) VALUES ('memory-1', ?, 'Brad', 'Prefers tea')`,
		src,
	)
	run(
		`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES ('server-1', ?, 'linear', 'https://mcp.example.com')`,
		src,
	)
	run(
		`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at)
		 VALUES (?, ?, 'package', ?, ?)`,
		src,
		`package:${pkgA}`,
		now,
		now,
	)
	return { sqlite, db }
}

type Calls = Array<string>

function createEffects(input: {
	db: D1Database
	calls: Calls
	backups: Array<string>
	overrides?: Partial<OrgTransferEffects>
}): OrgTransferEffects {
	const { db, calls } = input
	const writer = {
		appDb: db,
		db,
		actorUserId: 'person-admin',
		actorUsername: 'admin',
		credentialKind: null,
		credentialId: null,
	}
	return {
		withWriteLease: async (ownerId, write) => {
			calls.push(`lease:${ownerId}`)
			return await write()
		},
		loadSnapshot: ({ from, to }) =>
			loadOrgTransferSnapshot({
				env: { APP_DB: db } as Env,
				from,
				to,
			}),
		reseal: (plan) => resealOrgTransferSecrets({ env, plan }),
		writeBackup: async ({ key, backup }) => {
			calls.push(`backup:${key}`)
			input.backups.push(JSON.stringify(backup))
		},
		copyLogo: async (copy) => {
			calls.push(`copyLogo:${copy.toKey}`)
		},
		deleteLogo: async (key) => {
			calls.push(`deleteLogo:${key}`)
		},
		copyStorage: async ({ storageId }) => {
			calls.push(`copyStorage:${storageId}`)
			return { storageId, kvEntries: 2, sqlRows: { notes: 3 } }
		},
		clearStorage: async ({ userId, storageId }) => {
			calls.push(`clearStorage:${userId}:${storageId}`)
		},
		exportMcpServer: async ({ serverId }) => {
			calls.push(`exportMcp:${serverId}`)
			return {
				row: {
					id: serverId,
					name: 'linear',
					server_url: 'https://mcp.example.com',
					client_id: null,
					auth_url: null,
					callback_url: 'https://heykody.dev/callback',
					server_options: null,
				},
				entries: [],
			}
		},
		importMcpServer: async ({ userId, transfer }) => {
			calls.push(`importMcp:${userId}:${transfer.row.id}`)
			return {
				ok: true,
				connection: { id: transfer.row.id } as never,
			}
		},
		removeMcpServer: async ({ userId, serverId }) => {
			calls.push(`removeMcp:${userId}:${serverId}`)
		},
		jobCallerContextJson: async ({ userId, packageId }) =>
			JSON.stringify({ userId, packageId }),
		transferJobs: async ({ fromUserId, toUserId, jobs }) => {
			calls.push(`transferJobs:${fromUserId}->${toUserId}:${jobs.length}`)
			return { transferred: jobs.length }
		},
		planAudit: (events) => {
			const plans = events.map((event) =>
				planOrgAuditOutbox(writer, {
					orgId: event.orgId,
					action: event.action,
					details: event.details,
				}),
			)
			return {
				statements: plans.map((plan) =>
					orgAuditOutboxInsertStatement(db, plan),
				),
				deliver: async () => {
					calls.push('deliverAudit')
				},
			}
		},
		afterCommit: async ({ plan, cleanupOrphans }) => {
			calls.push(
				`afterCommit:${cleanupOrphans}:${plan.orphans
					.filter((orphan) => orphan.cleanup === 'entity-source')
					.map((orphan) => orphan.key)
					.join(',')}`,
			)
			return { leftovers: {}, warnings: [] }
		},
		...input.overrides,
	}
}

function dumpOwnedRows(sqlite: DatabaseSync) {
	return [
		'saved_packages',
		'entity_sources',
		'secret_buckets',
		'secret_entries',
		'user_oauth_apps',
		'user_integrations',
		'webhook_endpoints',
		'mcp_memories',
		'mcp_server_settings',
		'user_storage_buckets',
		'orgs',
		'org_audit_outbox',
	].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all())
}

function expectNoSecretMaterial(text: string, sqlite: DatabaseSync) {
	for (const value of Object.values(plaintexts)) {
		expect(text).not.toContain(value)
	}
	const ciphertexts = sqlite
		.prepare(
			`SELECT encrypted_value AS value FROM secret_entries
			 UNION ALL SELECT client_secret_encrypted FROM user_oauth_apps
			 UNION ALL SELECT access_token_encrypted FROM user_integrations
			 UNION ALL SELECT refresh_token_encrypted FROM user_integrations
			 UNION ALL SELECT url_secret_encrypted FROM webhook_endpoints
			 UNION ALL SELECT hmac_secret_encrypted FROM webhook_endpoints`,
		)
		.all() as Array<{ value: string | null }>
	for (const { value } of ciphertexts) {
		if (value) expect(text).not.toContain(value)
	}
}

test('dry-run reports the plan as counts and names and writes nothing', async () => {
	const { sqlite, db } = await seed()
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'dry-run',
		skipOrphans: false,
	})
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	expect(calls).toEqual([])
	expect(result.applied).toBe(false)
	expect(result.backupKey).toBeNull()
	expect(result.summary.packages.map((pkg) => pkg.to_name).sort()).toEqual([
		'@haveman/alpha',
		'@haveman/beta',
		'@haveman/gamma',
	])
	expect(result.summary.secrets).toEqual(
		expect.arrayContaining([
			{ scope: 'user', binding: '', name: 'API_KEY' },
			{ scope: 'package', binding: 'alpha', name: 'PKG_TOKEN' },
		]),
	)
	expect(result.summary.integrations).toEqual(['github'])
	expect(result.summary.oauth_apps).toEqual(['myapp'])
	expect(result.summary.mcp_servers).toEqual(['linear'])
	expect(result.summary.storages).toEqual([
		{ storage_id: `package:${pkgA}`, kind: 'package' },
		{ storage_id: `package:${pkgB}`, kind: 'package' },
		{ storage_id: `package:${pkgC}`, kind: 'package' },
	])
	expect(result.summary.orphans).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ table: 'entity_sources', key: 'src-orphan' }),
			expect.objectContaining({
				table: 'webhook_endpoints',
				key: 'hook-orphan',
			}),
		]),
	)
	expect(result.summary.clashes).toEqual([])
	expectNoSecretMaterial(JSON.stringify(result), sqlite)
})

test('apply refuses clashes in the target and touches nothing', async () => {
	const { sqlite, db } = await seed()
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('target-pkg', ?, '@haveman/alpha', 'alpha', 'desc', 'src-target')`,
		)
		.run(dst)
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('target-user', ?, 'user', '')`,
		)
		.run(dst)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('target-user', 'API_KEY', 'x')`,
		)
		.run()
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const error = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(OrgTransferRefusedError)
	const message = (error as Error).message
	expect(message).toContain('saved_packages: @haveman/alpha already exists')
	expect(message).toContain('saved_packages: alpha already exists')
	expect(message).toContain('secret_entries: user API_KEY already exists')
	expect(calls.filter((call) => !call.startsWith('lease:'))).toEqual([])
	expect(dumpOwnedRows(sqlite)).toEqual(before)
})

test('apply refuses orphans unless skipOrphans', async () => {
	const { sqlite, db } = await seed()
	const before = dumpOwnedRows(sqlite)
	await expect(
		runOrgResourceTransfer({
			db,
			effects: createEffects({ db, calls: [], backups: [] }),
			actorUserId: 'person-admin',
			fromOrgId: src,
			toOrgId: dst,
			mode: 'apply',
			skipOrphans: false,
		}),
	).rejects.toThrow(/orphaned row\(s\) found; pass skipOrphans/)
	expect(dumpOwnedRows(sqlite)).toEqual(before)
})

test('apply moves everything, re-seals credentials, and cleans up orphans', async () => {
	const { sqlite, db } = await seed()
	const calls: Calls = []
	const backups: Array<string> = []
	const logged: Array<string> = []
	const record = (...args: Array<unknown>) => {
		logged.push(args.map((arg) => String(arg)).join(' '))
	}
	const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
		(method) => vi.spyOn(console, method).mockImplementation(record),
	)
	const result = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	})
	for (const spy of spies) spy.mockRestore()

	expect(result.applied).toBe(true)
	expect(result.backupKey).toMatch(
		new RegExp(`^org-resource-transfers/${src}/${dst}/`),
	)
	expect(calls).toEqual([
		`lease:${dst}`,
		`lease:${src}`,
		`backup:${result.backupKey}`,
		`copyLogo:user-oauth-app-logos/${dst}/myapp.png`,
		`copyStorage:package:${pkgA}`,
		`copyStorage:package:${pkgB}`,
		`copyStorage:package:${pkgC}`,
		'exportMcp:server-1',
		`importMcp:${dst}:server-1`,
		'deliverAudit',
		'afterCommit:true:src-orphan',
	])

	const packages = sqlite
		.prepare(`SELECT id, user_id, name FROM saved_packages ORDER BY name`)
		.all()
	expect(packages).toEqual([
		{ id: pkgA, user_id: dst, name: '@haveman/alpha' },
		{ id: pkgB, user_id: dst, name: '@haveman/beta' },
		{ id: pkgC, user_id: dst, name: '@haveman/gamma' },
	])
	expect(
		sqlite.prepare(`SELECT id, user_id FROM entity_sources ORDER BY id`).all(),
	).toEqual([
		{ id: 'src-alpha', user_id: dst },
		{ id: 'src-beta', user_id: dst },
		{ id: 'src-gamma', user_id: dst },
		// Deleted with its artifacts by the post-commit step.
		{ id: 'src-orphan', user_id: src },
	])

	const secretRows = sqlite
		.prepare(
			`SELECT e.name, e.encrypted_value, b.user_id FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id ORDER BY e.name`,
		)
		.all() as Array<{ name: string; encrypted_value: string; user_id: string }>
	expect(secretRows.map((row) => row.user_id)).toEqual([dst, dst])
	for (const [row, plaintext] of [
		[secretRows[0]!, plaintexts.userSecret],
		[secretRows[1]!, plaintexts.packageSecret],
	] as const) {
		expect(
			await decryptSecretValue(
				env,
				row.encrypted_value,
				userSecretContext(dst),
			),
		).toBe(plaintext)
		await expect(
			decryptSecretValue(env, row.encrypted_value, userSecretContext(src)),
		).rejects.toThrow('Unable to decrypt secret value.')
	}

	const app = sqlite.prepare(`SELECT * FROM user_oauth_apps`).get() as Record<
		string,
		string
	>
	expect(app.user_id).toBe(dst)
	expect(app.logo_key).toBe(`user-oauth-app-logos/${dst}/myapp.png`)
	expect(
		await decryptUserOauthClientSecret(
			env,
			app.client_secret_encrypted!,
			userOauthAppCredentialContext(dst, 'myapp'),
		),
	).toBe(plaintexts.clientSecret)
	await expect(
		decryptUserOauthClientSecret(
			env,
			app.client_secret_encrypted!,
			userOauthAppCredentialContext(src, 'myapp'),
		),
	).rejects.toThrow('Unable to decrypt OAuth app client secret.')

	const integration = sqlite
		.prepare(`SELECT * FROM user_integrations`)
		.get() as Record<string, string>
	expect(integration.user_id).toBe(dst)
	expect(
		await decryptUserOauthAccessToken(
			env,
			integration.access_token_encrypted!,
			userIntegrationCredentialContext(dst, 'github'),
		),
	).toBe(plaintexts.accessToken)
	expect(
		await decryptUserOauthRefreshToken(
			env,
			integration.refresh_token_encrypted!,
			userIntegrationCredentialContext(dst, 'github'),
		),
	).toBe(plaintexts.refreshToken)
	await expect(
		decryptUserOauthAccessToken(
			env,
			integration.access_token_encrypted!,
			userIntegrationCredentialContext(src, 'github'),
		),
	).rejects.toThrow('Unable to decrypt integration access token.')

	const hook = sqlite
		.prepare(`SELECT * FROM webhook_endpoints WHERE id = 'hook-1'`)
		.get() as Record<string, string>
	expect(hook.user_id).toBe(dst)
	expect(
		await decryptWebhookUrlSecret(
			env,
			hook.url_secret_encrypted!,
			userWebhookUrlSecretContext(dst, 'hook-1'),
		),
	).toBe(plaintexts.webhookUrl)
	expect(
		await decryptWebhookHmacSecret(
			env,
			hook.hmac_secret_encrypted!,
			userWebhookHmacSecretContext(dst, 'hook-1'),
		),
	).toBe(plaintexts.webhookHmac)
	const orphanHook = sqlite
		.prepare(
			`SELECT user_id, deleted_at FROM webhook_endpoints WHERE id = 'hook-orphan'`,
		)
		.get() as { user_id: string; deleted_at: string | null }
	expect(orphanHook.user_id).toBe(src)
	expect(orphanHook.deleted_at).not.toBeNull()

	for (const table of [
		'mcp_memories',
		'mcp_server_settings',
		'user_storage_buckets',
	]) {
		expect(
			sqlite.prepare(`SELECT DISTINCT user_id FROM ${table}`).all(),
		).toEqual([{ user_id: dst }])
	}
	expect(
		sqlite.prepare(`SELECT id, access_epoch FROM orgs ORDER BY id`).all(),
	).toEqual([
		{ id: dst, access_epoch: 1 },
		{ id: src, access_epoch: 1 },
	])
	const audit = sqlite
		.prepare(
			`SELECT org_id, payload_json FROM org_audit_outbox ORDER BY org_id`,
		)
		.all() as Array<{ org_id: string; payload_json: string }>
	expect(
		audit.map((row) => [row.org_id, JSON.parse(row.payload_json).action]),
	).toEqual([
		[dst, 'org.resources_transferred_in'],
		[src, 'org.resources_transferred_out'],
	])

	// The backup keeps the source ciphertext so restore is a row write.
	expect(backups).toHaveLength(1)
	for (const value of Object.values(plaintexts)) {
		expect(backups[0]).not.toContain(value)
	}
	expect(backups[0]).toContain('"encrypted_value"')

	expectNoSecretMaterial(JSON.stringify(result), sqlite)
	expectNoSecretMaterial(
		audit.map((row) => row.payload_json).join('\n'),
		sqlite,
	)
	expectNoSecretMaterial(logged.join('\n'), sqlite)
})

test('a failure before commit undoes side copies and leaves APP_DB unchanged', async () => {
	const { sqlite, db } = await seed()
	const jobId = buildPackageJobId(pkgA, 'nightly')
	jobsMock.jobs = [
		{
			id: jobId,
			user_id: src,
			callerContextJson: '{"original":true}',
			record: {
				id: jobId,
				name: 'nightly',
				sourceId: 'src-alpha',
				storageId: `job:${jobId}`,
			},
		} as unknown as JobRow,
	]
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const effects = createEffects({
		db,
		calls,
		backups: [],
		overrides: {
			planAudit: () => ({
				// Fails inside the batch, after every side copy is done.
				statements: [db.prepare(`INSERT INTO no_such_table VALUES (1)`)],
				deliver: async () => {},
			}),
		},
	})
	const error = await runOrgResourceTransfer({
		db,
		effects,
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(Error)
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	const undo = calls.slice(calls.indexOf(`transferJobs:${src}->${dst}:1`) + 1)
	expect(undo).toEqual([
		`transferJobs:${dst}->${src}:1`,
		`removeMcp:${dst}:server-1`,
		`clearStorage:${dst}:job:${jobId}`,
		`clearStorage:${dst}:package:${pkgC}`,
		`clearStorage:${dst}:package:${pkgB}`,
		`clearStorage:${dst}:package:${pkgA}`,
		`deleteLogo:user-oauth-app-logos/${dst}/myapp.png`,
	])
	expectNoSecretMaterial(String((error as Error).message), sqlite)
})

test('a storage copy failure part way stops before any later step', async () => {
	const { sqlite, db } = await seed()
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	await expect(
		runOrgResourceTransfer({
			db,
			effects: createEffects({
				db,
				calls,
				backups: [],
				overrides: {
					copyStorage: async () => {
						throw new Error('Storage package:x copy did not verify.')
					},
				},
			}),
			actorUserId: 'person-admin',
			fromOrgId: src,
			toOrgId: dst,
			mode: 'apply',
			skipOrphans: true,
		}),
	).rejects.toThrow('copy did not verify')
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	expect(calls.some((call) => call.startsWith('importMcp'))).toBe(false)
	expect(calls).toContain(`clearStorage:${dst}:package:${pkgA}`)
	expect(calls).toContain(`deleteLogo:user-oauth-app-logos/${dst}/myapp.png`)
})

test('a ciphertext that does not open fails with a generic message before any write', async () => {
	const { sqlite, db } = await seed()
	sqlite
		.prepare(
			`UPDATE secret_entries SET encrypted_value = ? WHERE name = 'API_KEY'`,
		)
		.run(
			await encryptSecretValue(
				env,
				plaintexts.userSecret,
				userSecretContext(dst),
			),
		)
	const calls: Calls = []
	const before = dumpOwnedRows(sqlite)
	const error = await runOrgResourceTransfer({
		db,
		effects: createEffects({ db, calls, backups: [] }),
		actorUserId: 'person-admin',
		fromOrgId: src,
		toOrgId: dst,
		mode: 'apply',
		skipOrphans: true,
	}).catch((caught: unknown) => caught)
	expect((error as Error).message).toBe(
		'Could not re-seal encrypted_value for secret API_KEY.',
	)
	expect(calls.filter((call) => !call.startsWith('lease:'))).toEqual([])
	expect(dumpOwnedRows(sqlite)).toEqual(before)
	expectNoSecretMaterial((error as Error).message, sqlite)
})

test('transfer refuses the same org, a missing org, and a suspended org', async () => {
	const { sqlite, db } = await seed()
	const effects = createEffects({ db, calls: [], backups: [] })
	const base = {
		db,
		effects,
		actorUserId: 'person-admin',
		mode: 'dry-run' as const,
		skipOrphans: false,
	}
	await expect(
		runOrgResourceTransfer({ ...base, fromOrgId: src, toOrgId: src }),
	).rejects.toThrow('Source and target org are the same.')
	await expect(
		runOrgResourceTransfer({ ...base, fromOrgId: src, toOrgId: 'nope' }),
	).rejects.toThrow('The target org nope is not live.')
	sqlite.prepare(`UPDATE orgs SET suspended_at = ? WHERE id = ?`).run(now, dst)
	await expect(
		runOrgResourceTransfer({ ...base, fromOrgId: src, toOrgId: dst }),
	).rejects.toThrow('The target org @haveman is suspended.')
})
