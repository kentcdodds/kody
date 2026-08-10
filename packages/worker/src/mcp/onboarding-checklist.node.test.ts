import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { upsertIntegration } from '#worker/integrations/service.ts'
import { insertMemory } from '#mcp/memory/repo.ts'
import { buildOnboardingSearchNotice } from '#mcp/tools/search-onboarding-notice.ts'
import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	readOnboardingChecklistDismissed,
	userHasSentWelcomeEmail,
} from './onboarding-checklist.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const { env: meterEnv, seed } = createInMemoryUserMeterEnv()
	// MAILBOX is deliberately absent: the mailbox probe must fail open.
	return {
		env: { APP_DB: createD1FromSqlite(sqlite), ...meterEnv } as Env,
		seed,
	}
}

const userId = 'a'.repeat(64)

test('checklist derives from stored signals, fails open on missing bindings, and dismissal round-trips', async () => {
	const { env } = createEnv()

	const fresh = await deriveOnboardingChecklist({
		env,
		userId,
		emailVerified: true,
		hasMcpClient: true,
	})
	expect(fresh.complete).toBe(false)
	expect(Object.fromEntries(fresh.items.map((i) => [i.id, i.done]))).toEqual({
		'verify-email': true,
		'connect-agent': true,
		// No MAILBOX binding in this env: the probe fails open to "not done".
		'first-hello': false,
		'save-memory': false,
		'connect-integration': false,
		'install-starter': false,
	})

	await insertMemory(env.APP_DB, {
		id: 'memory-1',
		user_id: userId,
		category: 'workflow',
		status: 'active',
		subject: 'Kody user',
		summary: 'Prefers concise answers.',
		details: 'Prefers concise answers.',
		tags_json: '[]',
		source_uris_json: '[]',
		dedupe_key: null,
		last_accessed_at: null,
		deleted_at: null,
	})
	await upsertIntegration({
		env,
		userId,
		config: {
			name: 'github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'confidential',
			clientId: 'client-id',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			refreshTokenSecretName: 'githubRefreshToken',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['read:user'],
				scopeSeparator: null,
				extraAuthorizeParams: {},
			},
		},
	})

	const progressed = await deriveOnboardingChecklist({
		env,
		userId,
		emailVerified: true,
		hasMcpClient: true,
	})
	const doneById = Object.fromEntries(
		progressed.items.map((i) => [i.id, i.done]),
	)
	expect(doneById['save-memory']).toBe(true)
	expect(doneById['connect-integration']).toBe(true)
	expect(progressed.complete).toBe(false)

	// Dismissal is a user-scoped value that round-trips.
	expect(await readOnboardingChecklistDismissed({ env, userId })).toBe(false)
	await dismissOnboardingChecklist({ env, userId })
	expect(await readOnboardingChecklistDismissed({ env, userId })).toBe(true)
})

test('search onboarding notice points at /onboarding and goes quiet after dismissal', async () => {
	const { env } = createEnv()

	const notice = await buildOnboardingSearchNotice({
		env,
		userId,
		baseUrl: 'https://kody.example',
	})
	expect(notice).toContain('https://kody.example/onboarding')
	expect(typeof notice).toBe('string')
	expect(notice!.length).toBeGreaterThan(0)

	await dismissOnboardingChecklist({ env, userId })
	expect(
		await buildOnboardingSearchNotice({
			env,
			userId,
			baseUrl: 'https://kody.example',
		}),
	).toBe(null)
})

test('first-win Send is done when email_send meter counts even without mailbox', async () => {
	const now = new Date('2026-08-08T15:00:00.000Z')
	const fresh = createEnv()
	expect(await userHasSentWelcomeEmail({ env: fresh.env, userId, now })).toBe(
		false,
	)

	const { env, seed } = createEnv()
	await seed({
		userId,
		resource: 'email_sends_per_day',
		day: utcDayKey(now),
		count: 1,
	})
	expect(await userHasSentWelcomeEmail({ env, userId, now })).toBe(true)
	expect(
		await userHasSentWelcomeEmail({ env, userId: 'b'.repeat(64), now }),
	).toBe(false)
})
