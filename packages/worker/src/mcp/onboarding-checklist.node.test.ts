import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { buildOnboardingSearchNotice } from '#mcp/tools/search-onboarding-notice.ts'
import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	loadOnboardingAccessWin,
	readOnboardingChecklistDismissed,
} from './onboarding-checklist.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const { env: meterEnv } = createInMemoryUserMeterEnv()
	return {
		env: { APP_DB: createD1FromSqlite(sqlite), ...meterEnv } as Env,
	}
}

const userId = 'a'.repeat(64)

async function seedUser(db: D1Database, stableUserId = userId) {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			`user-${stableUserId.slice(0, 8)}`,
			`${stableUserId.slice(0, 8)}@example.test`,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
		)
		.run()
}

async function readDismissedAt(db: D1Database, stableUserId = userId) {
	const row = await db
		.prepare(
			`SELECT onboarding_checklist_dismissed_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(stableUserId)
		.first<{ onboarding_checklist_dismissed_at: string | null }>()
	return row?.onboarding_checklist_dismissed_at ?? null
}

test('checklist derives wizard steps from grants and an access win, not integrations', async () => {
	const { env } = createEnv()
	await seedUser(env.APP_DB)

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
		'give-access': false,
		'connect-second-agent': false,
		'install-starter': false,
	})

	const progressed = await deriveOnboardingChecklist({
		env,
		userId,
		emailVerified: true,
		hasMcpClient: true,
		hasAccessWin: true,
		hasSecondMcpClient: true,
	})
	const doneById = Object.fromEntries(
		progressed.items.map((i) => [i.id, i.done]),
	)
	expect(doneById['give-access']).toBe(true)
	expect(doneById['connect-second-agent']).toBe(true)
	expect(progressed.complete).toBe(false)

	await env.APP_DB.prepare(
		`UPDATE users SET first_search_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	expect(await loadOnboardingAccessWin(env, userId)).toBe(true)

	expect(await readOnboardingChecklistDismissed({ env, userId })).toBe(false)
	await dismissOnboardingChecklist({ env, userId })
	expect(await readOnboardingChecklistDismissed({ env, userId })).toBe(true)
	expect(await readDismissedAt(env.APP_DB)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

test('search onboarding notice lists remaining wizard steps without writing dismissal', async () => {
	const { env } = createEnv()
	await seedUser(env.APP_DB)
	const envWithGrants = {
		...env,
		OAUTH_PROVIDER: {
			listUserGrants: async () => ({ items: [] }),
		},
	}

	const notice = await buildOnboardingSearchNotice({
		env: envWithGrants,
		userId,
		baseUrl: 'https://kody.example',
	})
	expect(notice).toContain('Connect your agent')
	expect(notice).toContain('Make something useful')
	expect(notice).toContain('Connect a second agent')
	expect(notice).toContain('/onboarding')
	expect(await readOnboardingChecklistDismissed({ env, userId })).toBe(false)
	expect(await readDismissedAt(env.APP_DB)).toBe(null)

	await dismissOnboardingChecklist({ env, userId })
	expect(
		await buildOnboardingSearchNotice({
			env: envWithGrants,
			userId,
			baseUrl: 'https://kody.example',
		}),
	).toBe(null)
})

test('search onboarding notice stays quiet when grant helpers cannot be resolved', async () => {
	const { env } = createEnv()
	await seedUser(env.APP_DB)
	expect(
		await buildOnboardingSearchNotice({
			env,
			userId,
			baseUrl: 'https://kody.example',
		}),
	).toBe(null)
})
