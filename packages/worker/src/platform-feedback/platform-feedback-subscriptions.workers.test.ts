import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	assignAdminRole,
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { platformFeedbackContentWarning } from './content-warning.ts'
import { dispatchPlatformFeedbackSubmittedSubscriptionEvent } from './package-subscriptions.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'

const platformBaseUrl = 'https://kody.example.com'

const openFeedback = {
	id: 'feedback-integration-1',
	submitterUserId: 'submitter-integration-1',
	submitterUsername: 'feedback-submitter',
	submitterEmail: 'feedback-submitter@example.com',
	category: 'suggestion' as const,
	summary: 'Make subscription failures easier to inspect',
	details: 'Include enough approved context in the admin notification.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	createdAt: '2026-07-19T01:00:00.000Z',
	updatedAt: '2026-07-19T01:00:00.000Z',
}

async function ensurePlatformFeedbackTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS platform_feedback (
				id TEXT PRIMARY KEY NOT NULL,
				submitter_user_id TEXT NOT NULL,
				submitter_username TEXT,
				submitter_email TEXT,
				category TEXT NOT NULL,
				summary TEXT NOT NULL,
				details TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'open',
				reviewed_by_user_id TEXT,
				reviewed_at TEXT,
				admin_note TEXT,
				revision INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	const columns = await db
		.prepare(`PRAGMA table_info(platform_feedback)`)
		.all<{ name: string }>()
	const columnNames = new Set(
		(columns.results ?? []).map((column) => column.name),
	)
	if (!columnNames.has('submitter_username')) {
		await db
			.prepare(
				`ALTER TABLE platform_feedback ADD COLUMN submitter_username TEXT`,
			)
			.run()
	}
	if (!columnNames.has('submitter_email')) {
		await db
			.prepare(`ALTER TABLE platform_feedback ADD COLUMN submitter_email TEXT`)
			.run()
	}
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
		summaryUntrusted: input.feedback?.summary_untrusted ?? null,
		detailsUntrusted: input.feedback?.details_untrusted ?? null,
		submitter: input.submitter ?? null,
		adminUrl: input.admin_url ?? null,
		contentWarning: input.content_warning ?? null,
		hasDeniedFields: [
			'admin_note',
			'reviewed_by_user_id',
			'reviewed_at',
			'revision',
			'updated_at',
			'roles',
			'plan',
		].some((field) =>
			Object.prototype.hasOwnProperty.call(input, field) ||
			Object.prototype.hasOwnProperty.call(input.feedback ?? {}, field) ||
			Object.prototype.hasOwnProperty.call(input.submitter ?? {}, field)
		),
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

// Package subscription dispatch boots the real Worker Loader sandbox, which
// costs seconds per run. The shared default is 5s locally (20s in CI), so
// budget these explicitly like the other sandbox-executing suites rather than
// letting them flake under a loaded `npm run validate`.
const subscriptionDispatchTimeoutMs = 60_000

test(
	'platform feedback dispatch keeps stored identity snapshots idempotent across live account changes and reaches only admin subscribers',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensurePackageSubscriptionTestSchema(env.APP_DB)
		await ensurePlatformFeedbackTestSchema(env.APP_DB)
		await ensureRbacTestSchema(env.APP_DB)

		const submitterEmail = `feedback-submitter-${crypto.randomUUID()}@example.com`
		const submitterUsername = `feedbacksubmitter-${crypto.randomUUID().slice(0, 8)}`
		const submitterStableId = await createStableUserIdFromEmail(submitterEmail)
		const submitterAccountId = await seedAccount({
			db: env.APP_DB,
			email: submitterEmail,
			username: submitterUsername,
		})
		const dispatchFeedback = {
			...openFeedback,
			submitterUserId: submitterStableId,
			submitterUsername,
			submitterEmail,
		}
		await env.APP_DB.prepare(
			`INSERT OR REPLACE INTO platform_feedback (
			id, submitter_user_id, submitter_username, submitter_email,
			category, summary, details, status, reviewed_by_user_id,
			reviewed_at, admin_note, revision, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
		)
			.bind(
				dispatchFeedback.id,
				dispatchFeedback.submitterUserId,
				dispatchFeedback.submitterUsername,
				dispatchFeedback.submitterEmail,
				dispatchFeedback.category,
				dispatchFeedback.summary,
				dispatchFeedback.details,
				dispatchFeedback.status,
				dispatchFeedback.createdAt,
				dispatchFeedback.updatedAt,
			)
			.run()

		const adminEmail = `feedback-sub-admin-${crypto.randomUUID()}@example.com`
		const adminStableId = await createStableUserIdFromEmail(adminEmail)
		const adminAccountId = await seedAccount({
			db: env.APP_DB,
			email: adminEmail,
			username: `feedbackadmin-${crypto.randomUUID().slice(0, 8)}`,
		})
		await assignAdminRole({ db: env.APP_DB, userId: adminAccountId })

		const regularEmail = `feedback-sub-user-${crypto.randomUUID()}@example.com`
		const regularStableId = await createStableUserIdFromEmail(regularEmail)
		await seedAccount({
			db: env.APP_DB,
			email: regularEmail,
			username: `feedbackuser-${crypto.randomUUID().slice(0, 8)}`,
		})

		const bundleKv = new Map<string, string>()
		const expectedPayload = buildPlatformFeedbackSubmittedEvent({
			baseUrl: platformBaseUrl,
			feedback: dispatchFeedback,
		})
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
				feedbackId: dispatchFeedback.id,
			})
			await env.APP_DB.prepare(
				`UPDATE users SET username = ?, email = ? WHERE id = ?`,
			)
				.bind(
					`changed-${crypto.randomUUID().slice(0, 8)}`,
					`changed-${crypto.randomUUID()}@example.com`,
					submitterAccountId,
				)
				.run()
			await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
				env: { ...env, APP_BASE_URL: platformBaseUrl },
				feedbackId: dispatchFeedback.id,
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
					idempotency_key: `platform-feedback:${dispatchFeedback.id}:${adminPackage.packageId}:${platformFeedbackSubmittedTopic}`,
				})
				const response = JSON.parse(String(invocation?.['response_json'])) as {
					body: Record<string, unknown>
				}
				expect(response.body).toMatchObject({
					ok: true,
					result: {
						payloadMatches: true,
						event: platformFeedbackSubmittedTopic,
						feedbackId: dispatchFeedback.id,
						summaryUntrusted: dispatchFeedback.summary,
						detailsUntrusted: dispatchFeedback.details,
						submitter: {
							user_id: submitterStableId,
							username: submitterUsername,
							email: submitterEmail,
						},
						adminUrl: `${platformBaseUrl}/admin/platform-feedback?feedbackId=${dispatchFeedback.id}`,
						contentWarning: platformFeedbackContentWarning,
						hasDeniedFields: false,
					},
				})
			}
			expect(
				invocations.results?.some(
					(row) => row['package_id'] === regularPackage.packageId,
				),
			).toBe(false)

			const countInvocations = async () => {
				const row = await env.APP_DB.prepare(
					`SELECT COUNT(*) AS total FROM package_invocations`,
				).first<{ total: number }>()
				return row?.total ?? 0
			}
			await env.APP_DB.prepare(`DELETE FROM user_roles`).run()
			const before = await countInvocations()
			const withoutAdmins =
				await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
					env: { ...env, APP_BASE_URL: platformBaseUrl },
					feedbackId: 'feedback-without-admins',
				})
			expect(withoutAdmins).toEqual([])
			expect(await countInvocations()).toBe(before)

			await env.APP_DB.prepare(`DROP TABLE user_roles`).run()
			await env.APP_DB.prepare(`DROP TABLE roles`).run()
			const beforeRbac =
				await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
					env: { ...env, APP_BASE_URL: platformBaseUrl },
					feedbackId: 'feedback-before-rbac',
				})
			expect(beforeRbac).toEqual([])
			expect(await countInvocations()).toBe(before)
		} finally {
			Object.assign(env, { BUNDLE_ARTIFACTS_KV: originalKv })
		}
	},
	subscriptionDispatchTimeoutMs,
)
