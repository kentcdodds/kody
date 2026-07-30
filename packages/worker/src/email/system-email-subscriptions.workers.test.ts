import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import { listEmailMessages } from './repo.ts'
import { systemEmailOwnerId } from './system-email.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { exportRunRecords } from '#worker/run-records/service.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	assignAdminRole,
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const platformBaseUrl = 'https://kody.example.com'
const systemDomain = 'kody.example.com'
const systemTopic = 'email.system-message.received'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
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

// Package subscription dispatch boots the real Worker Loader sandbox, which
// costs seconds per run. The shared default is 5s locally (20s in CI), so
// budget these explicitly like the other sandbox-executing suites rather than
// letting them flake under a loaded `npm run validate`.
const subscriptionDispatchTimeoutMs = 60_000

test(
	'system inbound email dispatches email.system-message.received to admin-saved packages only',
	async () => {
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
			db: env.APP_DB,
			email: adminEmail,
			username: `sysadmin-${crypto.randomUUID().slice(0, 8)}`,
			plan: 'max',
		})
		await assignAdminRole({ db: env.APP_DB, userId: adminAccountId })

		const regularEmail = `system-sub-user-${crypto.randomUUID()}@example.com`
		const regularStableId = await createStableUserIdFromEmail(regularEmail)
		await seedAccount({
			db: env.APP_DB,
			email: regularEmail,
			username: `sysuser-${crypto.randomUUID().slice(0, 8)}`,
			plan: 'max',
		})

		const bundleKv = new Map<string, string>()
		const adminPackage = await seedSubscribedPackage({
			bundleKv,
			userId: adminStableId,
			scope: 'sysadmin',
		})
		// A non-admin saving the identical subscription must never receive
		// operator system mail.
		await seedSubscribedPackage({
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
			for (let index = 0; index < waitUntilPromises.length; index += 1) {
				await waitUntilPromises[index]
			}

			const [stored] = await listEmailMessages({
				db: env.APP_DB,
				userId: systemEmailOwnerId,
				limit: 1,
			})
			expect(stored).toBeDefined()
			if (!stored) throw new Error('Expected stored system message')

			// The keyed idempotency ledger lives in each owner's RunLog DO now.
			const adminInvocations = (
				await exportRunRecords({ env, userId: adminStableId, pageSize: 100 })
			).packageInvocations
			const regularInvocations = (
				await exportRunRecords({ env, userId: regularStableId, pageSize: 100 })
			).packageInvocations
			expect(regularInvocations).toHaveLength(0)
			expect(adminInvocations).toHaveLength(1)
			const invocation = adminInvocations[0]
			expect(invocation).toMatchObject({
				packageId: adminPackage.packageId,
				exportName: `subscription:${systemTopic}`,
				topic: systemTopic,
				source: 'email',
				idempotencyKey: `email:${stored.id}:${adminPackage.packageId}:${systemTopic}`,
			})
			const responseJson = invocation?.responseJson
			if (!responseJson) {
				throw new Error('Expected a stored replay response for the admin row.')
			}
			const response = JSON.parse(responseJson) as {
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
	},
	subscriptionDispatchTimeoutMs,
)

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
	for (let index = 0; index < waitUntilPromises.length; index += 1) {
		await waitUntilPromises[index]
	}

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		limit: 5,
	})
	expect(messages.some((row) => row.subject === 'No admins yet')).toBe(true)
})
