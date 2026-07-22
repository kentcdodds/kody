import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import { listEmailMessages } from './repo.ts'
import { systemEmailOwnerId } from './system-email.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const platformBaseUrl = 'https://kody.example.com'
const systemDomain = 'kody.example.com'
const systemTopic = 'email.system-message.received'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function ensurePackageSubscriptionTestSchema(db: D1Database) {
	const statements = [
		`CREATE TABLE IF NOT EXISTS saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			source_id TEXT NOT NULL,
			has_app INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0,
			is_private INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL,
			source_root TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			artifact_kind TEXT NOT NULL,
			artifact_name TEXT,
			entry_point TEXT NOT NULL,
			kv_key TEXT NOT NULL,
			dependencies_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_published_bundle_artifacts_identity
		ON published_bundle_artifacts(user_id, source_id, artifact_kind, COALESCE(artifact_name, ''), entry_point)`,
		`CREATE TABLE IF NOT EXISTS package_invocations (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			token_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			package_kody_id TEXT NOT NULL,
			export_name TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			request_hash TEXT NOT NULL,
			source TEXT,
			topic TEXT,
			status TEXT NOT NULL,
			response_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_package_invocations_key
		ON package_invocations(user_id, token_id, package_id, export_name, idempotency_key)`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
	try {
		await db
			.prepare(
				`ALTER TABLE saved_packages ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1`,
			)
			.run()
	} catch {
		// Column already present on newer schemas.
	}
}

async function ensureRbacTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS roles (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				name TEXT NOT NULL UNIQUE,
				description TEXT NOT NULL DEFAULT ''
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS user_roles (
				user_id INTEGER NOT NULL,
				role_id INTEGER NOT NULL,
				PRIMARY KEY (user_id, role_id)
			)`,
		)
		.run()
	await db
		.prepare(`INSERT OR IGNORE INTO roles (name) VALUES ('user'), ('admin')`)
		.run()
}

async function seedAccount(input: { email: string; username: string }) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
		 VALUES (?, ?, 'test-password-hash', ?, ?)
		 ON CONFLICT(email) DO UPDATE SET
			username = excluded.username,
			stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(input.username, input.email, new Date().toISOString(), stableUserId)
		.run()
	const row = await env.APP_DB.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(input.email)
		.first<{ id: number }>()
	if (!row) throw new Error(`Expected seeded user row for ${input.email}`)
	return row.id
}

async function assignAdminRole(userId: number) {
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO user_roles (user_id, role_id)
		 SELECT ?, id FROM roles WHERE name = 'admin'`,
	)
		.bind(userId)
		.run()
}

async function seedSubscribedPackage(input: {
	bundleKv: Map<string, string>
	userId: string
	scope: string
}) {
	const db = env.APP_DB
	const sourceId = `source-${crypto.randomUUID()}`
	const packageId = `package-${crypto.randomUUID()}`
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text, source_id, has_app, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		)
		.bind(
			packageId,
			input.userId,
			`@${input.scope}/system-email-notifier`,
			'system-email-notifier',
			'System email notifier',
			sourceId,
			now,
			now,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, 'repo-1', 'commit-1', NULL, 'package.json', '/', ?, ?)`,
		)
		.bind(sourceId, input.userId, packageId, now, now)
		.run()

	const manifest = {
		name: `@${input.scope}/system-email-notifier`,
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: 'system-email-notifier',
			description: 'System email notifier',
			subscriptions: {
				[systemTopic]: {
					handler: './src/on-system-email.ts',
				},
			},
		},
	}
	input.bundleKv.set(
		buildPublishedSourceManifestSnapshotKvKey({
			sourceId,
			publishedCommit: 'commit-1',
		}),
		JSON.stringify({
			version: 1,
			sourceId,
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			manifestContent: JSON.stringify(manifest),
			createdAt: now,
		}),
	)

	const subscriptionArtifact = {
		version: 1,
		kind: 'module',
		artifactName: `subscription:${systemTopic}`,
		sourceId,
		publishedCommit: 'commit-1',
		entryPoint: 'src/on-system-email.ts',
		mainModule: 'dist/subscription.js',
		modules: {
			'dist/subscription.js': `
export default async function main(input = {}) {
	return {
		event: input.event,
		messageId: input.message?.id ?? null,
		subject: input.message?.subject ?? null,
		adminUrl: input.admin_url ?? null,
	}
}
`,
		},
		dependencies: [],
		packageContext: {
			packageId,
			kodyId: 'system-email-notifier',
			sourceId,
		},
		serviceContext: null,
		createdAt: now,
	}
	const artifactKey = `bundle-artifact:v1:${sourceId}:commit-1:module:subscription:${systemTopic}:src/on-system-email.ts`
	input.bundleKv.set(artifactKey, JSON.stringify(subscriptionArtifact))
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, 'commit-1', 'module', ?, 'src/on-system-email.ts', ?, '[]', ?, ?)`,
		)
		.bind(
			`artifact-${crypto.randomUUID()}`,
			input.userId,
			sourceId,
			`subscription:${systemTopic}`,
			artifactKey,
			now,
			now,
		)
		.run()
	return { packageId, sourceId }
}

test('system inbound email dispatches email.system-message.received to admin-saved packages only', async () => {
	// The subscription runtime warns on optional lookups (e.g. MCP server
	// refs) whose tables are not part of this test's schema.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await ensureRbacTestSchema(env.APP_DB)

	const adminEmail = `system-sub-admin-${crypto.randomUUID()}@example.com`
	const adminStableId = await createStableUserIdFromEmail(adminEmail)
	const adminAccountId = await seedAccount({
		email: adminEmail,
		username: `sysadmin-${crypto.randomUUID().slice(0, 8)}`,
	})
	await assignAdminRole(adminAccountId)

	const regularEmail = `system-sub-user-${crypto.randomUUID()}@example.com`
	const regularStableId = await createStableUserIdFromEmail(regularEmail)
	await seedAccount({
		email: regularEmail,
		username: `sysuser-${crypto.randomUUID().slice(0, 8)}`,
	})

	const bundleKv = new Map<string, string>()
	const adminPackage = await seedSubscribedPackage({
		bundleKv,
		userId: adminStableId,
		scope: 'sysadmin',
	})
	// A non-admin saving the identical subscription must never receive
	// operator system mail.
	const regularPackage = await seedSubscribedPackage({
		bundleKv,
		userId: regularStableId,
		scope: 'sysuser',
	})

	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext

	const originalKv = env.BUNDLE_ARTIFACTS_KV
	Object.assign(env, {
		BUNDLE_ARTIFACTS_KV: {
			async get(key: string, type?: string) {
				const value = bundleKv.get(key) ?? null
				if (value == null) return null
				if (type === 'json') return JSON.parse(value) as unknown
				return value
			},
			async put() {
				return undefined
			},
			async delete() {
				return undefined
			},
		},
	})

	try {
		const message = createForwardableEmailMessage({
			from: 'provider@example.net',
			to: `postmaster@${systemDomain}`,
			raw: [
				'From: Provider <provider@example.net>',
				`To: postmaster@${systemDomain}`,
				'Subject: Delivery report',
				'Message-ID: <system-subscription@example.net>',
				'',
				'System body.',
			].join('\r\n'),
		})
		await handleInboundEmail(message, createInboundEnv(), ctx)
		expect(message.rejectedReason).toBeNull()
		await Promise.all(waitUntilPromises)

		const [stored] = await listEmailMessages({
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			limit: 1,
		})
		expect(stored).toBeDefined()
		if (!stored) throw new Error('Expected stored system message')

		const invocations = await env.APP_DB.prepare(
			`SELECT package_id, export_name, topic, source, idempotency_key, response_json
			FROM package_invocations
			WHERE package_id IN (?, ?)`,
		)
			.bind(adminPackage.packageId, regularPackage.packageId)
			.all<Record<string, unknown>>()
		expect(invocations.results).toHaveLength(1)
		const invocation = invocations.results?.[0]
		expect(invocation).toMatchObject({
			package_id: adminPackage.packageId,
			export_name: `subscription:${systemTopic}`,
			topic: systemTopic,
			source: 'email',
			idempotency_key: `email:${stored.id}:${adminPackage.packageId}:${systemTopic}`,
		})
		const response = JSON.parse(String(invocation?.['response_json'])) as {
			body: Record<string, unknown>
		}
		expect(response.body).toMatchObject({
			ok: true,
			result: {
				event: systemTopic,
				messageId: stored.id,
				subject: 'Delivery report',
				adminUrl: `${platformBaseUrl}/admin/system-email?messageId=${encodeURIComponent(stored.id)}`,
			},
		})
	} finally {
		Object.assign(env, { BUNDLE_ARTIFACTS_KV: originalKv })
	}
})

test('system inbound email dispatch is a no-op without admins or RBAC tables', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	// No RBAC tables at all: pre-RBAC databases must store system mail
	// without dispatching (and without throwing).
	await env.APP_DB.prepare(`DROP TABLE IF EXISTS user_roles`).run()
	await env.APP_DB.prepare(`DROP TABLE IF EXISTS roles`).run()

	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext

	const message = createForwardableEmailMessage({
		from: 'provider@example.net',
		to: `security@${systemDomain}`,
		raw: [
			'From: Provider <provider@example.net>',
			`To: security@${systemDomain}`,
			'Subject: No admins yet',
			'Message-ID: <system-no-admins@example.net>',
			'',
			'System body.',
		].join('\r\n'),
	})
	await handleInboundEmail(message, createInboundEnv(), ctx)
	expect(message.rejectedReason).toBeNull()
	await Promise.all(waitUntilPromises)

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		limit: 5,
	})
	expect(messages.some((row) => row.subject === 'No admins yet')).toBe(true)
})
