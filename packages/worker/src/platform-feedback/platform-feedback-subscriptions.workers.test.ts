import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { dispatchPlatformFeedbackSubmittedSubscriptionEvent } from './package-subscriptions.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'

const platformBaseUrl = 'https://kody.example.com'

const openFeedback = {
	id: 'feedback-integration-1',
	submitterUserId: 'submitter-integration-1',
	category: 'suggestion' as const,
	summary: 'Make subscription failures easier to inspect',
	details: 'Full feedback details stay in the platform feedback table.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	createdAt: '2026-07-19T01:00:00.000Z',
	updatedAt: '2026-07-19T01:00:00.000Z',
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
}

async function ensureRbacTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				username TEXT NOT NULL UNIQUE,
				email TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				email_verified_at TEXT,
				stable_user_id TEXT,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
		)
		.run()
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
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at)
		 VALUES (?, ?, 'test-password-hash', ?)
		 ON CONFLICT(email) DO UPDATE SET
			username = excluded.username,
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(input.username, input.email, new Date().toISOString())
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
	suffix: string
	expectedPayload: unknown
}) {
	const db = env.APP_DB
	const sourceId = `source-${crypto.randomUUID()}`
	const packageId = `package-${crypto.randomUUID()}`
	const kodyId = `platform-feedback-notifier-${input.suffix}`
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
			`@${input.scope}/${kodyId}`,
			kodyId,
			'Platform feedback notifier',
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
		name: `@${input.scope}/${kodyId}`,
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: kodyId,
			description: 'Platform feedback notifier',
			subscriptions: {
				[platformFeedbackSubmittedTopic]: {
					handler: './src/on-platform-feedback.ts',
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

	const expectedPayloadJson = JSON.stringify(input.expectedPayload)
	const subscriptionArtifact = {
		version: 1,
		kind: 'module',
		artifactName: `subscription:${platformFeedbackSubmittedTopic}`,
		sourceId,
		publishedCommit: 'commit-1',
		entryPoint: 'src/on-platform-feedback.ts',
		mainModule: 'dist/subscription.js',
		modules: {
			'dist/subscription.js': `
const expectedPayload = ${expectedPayloadJson}

export default async function main(input = {}) {
	return {
		payloadMatches: JSON.stringify(input) === JSON.stringify(expectedPayload),
		event: input.event ?? null,
		feedbackId: input.feedback?.id ?? null,
		hasDetails: Object.prototype.hasOwnProperty.call(input.feedback ?? {}, 'details'),
	}
}
`,
		},
		dependencies: [],
		packageContext: {
			packageId,
			kodyId,
			sourceId,
		},
		serviceContext: null,
		createdAt: now,
	}
	const artifactKey = `bundle-artifact:v1:${sourceId}:commit-1:module:subscription:${platformFeedbackSubmittedTopic}:src/on-platform-feedback.ts`
	input.bundleKv.set(artifactKey, JSON.stringify(subscriptionArtifact))
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, 'commit-1', 'module', ?, 'src/on-platform-feedback.ts', ?, '[]', ?, ?)`,
		)
		.bind(
			`artifact-${crypto.randomUUID()}`,
			input.userId,
			sourceId,
			`subscription:${platformFeedbackSubmittedTopic}`,
			artifactKey,
			now,
			now,
		)
		.run()
	return { packageId }
}

test('platform feedback dispatch is opaque, idempotent, and limited to every admin subscriber', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await ensureRbacTestSchema(env.APP_DB)

	const adminEmail = `feedback-sub-admin-${crypto.randomUUID()}@example.com`
	const adminStableId = await createStableUserIdFromEmail(adminEmail)
	const adminAccountId = await seedAccount({
		email: adminEmail,
		username: `feedbackadmin-${crypto.randomUUID().slice(0, 8)}`,
	})
	await assignAdminRole(adminAccountId)

	const regularEmail = `feedback-sub-user-${crypto.randomUUID()}@example.com`
	const regularStableId = await createStableUserIdFromEmail(regularEmail)
	await seedAccount({
		email: regularEmail,
		username: `feedbackuser-${crypto.randomUUID().slice(0, 8)}`,
	})

	const bundleKv = new Map<string, string>()
	const expectedPayload = buildPlatformFeedbackSubmittedEvent(openFeedback)
	const firstAdminPackage = await seedSubscribedPackage({
		bundleKv,
		userId: adminStableId,
		scope: 'feedbackadmin',
		suffix: 'first',
		expectedPayload,
	})
	const secondAdminPackage = await seedSubscribedPackage({
		bundleKv,
		userId: adminStableId,
		scope: 'feedbackadmin',
		suffix: 'second',
		expectedPayload,
	})
	const regularPackage = await seedSubscribedPackage({
		bundleKv,
		userId: regularStableId,
		scope: 'feedbackuser',
		suffix: 'regular',
		expectedPayload,
	})

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
		await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: { ...env, APP_BASE_URL: platformBaseUrl },
			feedback: openFeedback,
		})
		await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: { ...env, APP_BASE_URL: platformBaseUrl },
			feedback: openFeedback,
		})

		const invocations = await env.APP_DB.prepare(
			`SELECT package_id, token_id, export_name, topic, source, idempotency_key, response_json
			 FROM package_invocations
			 WHERE package_id IN (?, ?, ?)`,
		)
			.bind(
				firstAdminPackage.packageId,
				secondAdminPackage.packageId,
				regularPackage.packageId,
			)
			.all<Record<string, unknown>>()
		expect(invocations.results).toHaveLength(2)
		for (const adminPackage of [firstAdminPackage, secondAdminPackage]) {
			const invocation = invocations.results?.find(
				(row) => row['package_id'] === adminPackage.packageId,
			)
			expect(invocation).toMatchObject({
				package_id: adminPackage.packageId,
				token_id: 'internal:platform-feedback-subscriptions',
				export_name: `subscription:${platformFeedbackSubmittedTopic}`,
				topic: platformFeedbackSubmittedTopic,
				source: 'platform-feedback',
				idempotency_key: `platform-feedback:${openFeedback.id}:${adminPackage.packageId}:${platformFeedbackSubmittedTopic}`,
			})
			const response = JSON.parse(String(invocation?.['response_json'])) as {
				body: Record<string, unknown>
			}
			expect(response.body).toMatchObject({
				ok: true,
				result: {
					payloadMatches: true,
					event: platformFeedbackSubmittedTopic,
					feedbackId: openFeedback.id,
					hasDetails: false,
				},
			})
		}
		expect(
			invocations.results?.some(
				(row) => row['package_id'] === regularPackage.packageId,
			),
		).toBe(false)
	} finally {
		Object.assign(env, { BUNDLE_ARTIFACTS_KV: originalKv })
	}
})

test('platform feedback dispatch is a no-op without admins or RBAC tables', async () => {
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await ensureRbacTestSchema(env.APP_DB)
	await env.APP_DB.prepare(`DELETE FROM user_roles`).run()
	const countInvocations = async () => {
		const row = await env.APP_DB.prepare(
			`SELECT COUNT(*) AS total FROM package_invocations`,
		).first<{ total: number }>()
		return row?.total ?? 0
	}
	const before = await countInvocations()

	const withoutAdmins =
		await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: { ...env, APP_BASE_URL: platformBaseUrl },
			feedback: { ...openFeedback, id: 'feedback-without-admins' },
		})
	expect(withoutAdmins).toEqual([])
	expect(await countInvocations()).toBe(before)

	await env.APP_DB.prepare(`DROP TABLE user_roles`).run()
	await env.APP_DB.prepare(`DROP TABLE roles`).run()
	const beforeRbac = await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
		env: { ...env, APP_BASE_URL: platformBaseUrl },
		feedback: { ...openFeedback, id: 'feedback-before-rbac' },
	})
	expect(beforeRbac).toEqual([])
	expect(await countInvocations()).toBe(before)
})
