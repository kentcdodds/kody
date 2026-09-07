import { expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testCookieSecret } from '#worker/test-support/auth-provider-harness.ts'
import { createUnsubscribeTipsHandler } from '#app/handlers/unsubscribe-tips.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	createTipsUnsubscribeToken,
	isTipsEmailsOptedOut,
	tipsUnsubscribeOneClickBody,
} from '#worker/usage/tips-unsubscribe.ts'

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData, status }) =>
		Response.json({ ok: true, status: status ?? 200, loaderData }),
	),
}))

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

async function insertUser(db: D1Database, userId = 'user-tips') {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan, account_type)
			 VALUES ('tips', 'tips@example.com', 'x', ?, 'free', 'person')`,
		)
		.bind(userId)
		.run()
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
	} as unknown as Env
}

test('unsubscribe-tips GET applies opt-out and POST accepts RFC one-click', async () => {
	const db = createDb()
	await insertUser(db)
	const env = createEnv(db)
	const handler = createUnsubscribeTipsHandler(env)
	const token = await createTipsUnsubscribeToken({
		env,
		userId: 'user-tips',
	})

	const missing = await handler.handler({
		request: new Request('https://example.com/unsubscribe/tips'),
		url: new URL('https://example.com/unsubscribe/tips'),
		params: {},
	} as never)
	expect(await missing.json()).toEqual({
		ok: true,
		status: 400,
		loaderData: {
			tipsUnsubscribe: {
				ok: false,
				error: 'Unsubscribe token is required.',
			},
		},
	})

	const getUrl = `https://example.com/unsubscribe/tips?token=${encodeURIComponent(token)}`
	const first = await handler.handler({
		request: new Request(getUrl),
		url: new URL(getUrl),
		params: {},
	} as never)
	expect(await first.json()).toEqual({
		ok: true,
		status: 200,
		loaderData: {
			tipsUnsubscribe: {
				ok: true,
				alreadyOptedOut: false,
				message: expect.stringContaining('unsubscribed from Kody tips'),
			},
		},
	})
	expect(await isTipsEmailsOptedOut({ db, userId: 'user-tips' })).toBe(true)

	vi.mocked(renderAppPage).mockClear()
	const again = await handler.handler({
		request: new Request(getUrl),
		url: new URL(getUrl),
		params: {},
	} as never)
	expect(await again.json()).toMatchObject({
		loaderData: {
			tipsUnsubscribe: { ok: true, alreadyOptedOut: true },
		},
	})

	const otherDb = createDb()
	await insertUser(otherDb, 'user-one-click')
	const otherEnv = createEnv(otherDb)
	const otherHandler = createUnsubscribeTipsHandler(otherEnv)
	const postToken = await createTipsUnsubscribeToken({
		env: otherEnv,
		userId: 'user-one-click',
	})
	const postUrl = `https://example.com/unsubscribe/tips?token=${encodeURIComponent(postToken)}`
	const posted = await otherHandler.handler({
		request: new Request(postUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: tipsUnsubscribeOneClickBody,
		}),
		url: new URL(postUrl),
		params: {},
	} as never)
	expect(posted.status).toBe(200)
	expect(await posted.text()).toContain('unsubscribed from Kody tips')
	expect(
		await isTipsEmailsOptedOut({ db: otherDb, userId: 'user-one-click' }),
	).toBe(true)
})
