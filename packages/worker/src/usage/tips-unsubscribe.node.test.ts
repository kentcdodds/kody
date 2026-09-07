import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testCookieSecret } from '#worker/test-support/auth-provider-harness.ts'
import {
	buildTipsUnsubscribeUrl,
	createTipsUnsubscribeToken,
	isTipsEmailsOptedOut,
	mintTipsUnsubscribeUrl,
	optOutTipsEmails,
	tipsUnsubscribeHeaders,
	verifyTipsUnsubscribeToken,
} from './tips-unsubscribe.ts'

const env = { COOKIE_SECRET: testCookieSecret } as Pick<Env, 'COOKIE_SECRET'>

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('tips unsubscribe tokens verify, opt-out is idempotent, and headers are RFC one-click', async () => {
	const token = await createTipsUnsubscribeToken({ env, userId: 'user-tips' })
	expect(await verifyTipsUnsubscribeToken({ env, token })).toEqual({
		userId: 'user-tips',
	})
	expect(
		await verifyTipsUnsubscribeToken({
			env,
			token: `${token.slice(0, -2)}xx`,
		}),
	).toBeNull()
	expect(
		await verifyTipsUnsubscribeToken({
			env: { COOKIE_SECRET: `${testCookieSecret}-other` },
			token,
		}),
	).toBeNull()

	const url = await mintTipsUnsubscribeUrl({
		env,
		appBaseUrl: 'https://kody.codes',
		userId: 'user-tips',
	})
	expect(url).toContain('/unsubscribe/tips?token=')
	expect(tipsUnsubscribeHeaders(url)).toEqual({
		'List-Unsubscribe': `<${url}>`,
		'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
	})
	expect(
		buildTipsUnsubscribeUrl({ appBaseUrl: 'https://kody.codes/', token }),
	).toBe(
		`https://kody.codes/unsubscribe/tips?token=${encodeURIComponent(token)}`,
	)

	const { db } = createDb()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan, account_type)
			 VALUES ('tips', 'tips@example.com', 'x', 'user-tips', 'free', 'person')`,
		)
		.run()
	expect(await isTipsEmailsOptedOut({ db, userId: 'user-tips' })).toBe(false)
	expect(
		await optOutTipsEmails({
			db,
			userId: 'user-tips',
			now: new Date('2026-09-07T12:00:00.000Z'),
		}),
	).toEqual({ optedOut: true, alreadyOptedOut: false })
	expect(await isTipsEmailsOptedOut({ db, userId: 'user-tips' })).toBe(true)
	expect(
		await optOutTipsEmails({
			db,
			userId: 'user-tips',
			now: new Date('2026-09-08T12:00:00.000Z'),
		}),
	).toEqual({ optedOut: true, alreadyOptedOut: true })
	expect(
		await optOutTipsEmails({ db, userId: 'missing', now: new Date() }),
	).toEqual({ optedOut: false, alreadyOptedOut: false })
})
