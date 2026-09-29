import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	deleteEmailSenderRule,
	EmailSenderRuleLimitError,
	EmailSenderRuleValidationError,
	evaluateEmailSenderRules,
	listEmailSenderRules,
	maxEmailSenderRulesPerUser,
	upsertEmailSenderRule,
} from './sender-rules.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('sender rule CRUD normalizes values, enforces validation/cap, and scopes deletes', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `rules-user-${crypto.randomUUID()}`

	const created = await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: ' Friend@Example.COM ',
		effect: 'block',
		note: 'known spammer',
	})
	expect(created).toMatchObject({
		userId,
		kind: 'address',
		value: 'friend@example.com',
		effect: 'block',
		note: 'known spammer',
	})
	expect(created.id).toBeTruthy()
	expect(created.updatedAt).toBe(created.createdAt)

	const updated = await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'friend@example.com',
		effect: 'quarantine',
		note: 'review instead',
	})
	expect(updated.id).toBe(created.id)
	expect(updated.effect).toBe('quarantine')
	expect(updated.note).toBe('review instead')
	expect(updated.createdAt).toBe(created.createdAt)
	expect(updated.updatedAt >= created.updatedAt).toBe(true)
	expect(await listEmailSenderRules({ db: env.APP_DB, userId })).toHaveLength(1)

	// Representative invalid shapes (address vs domain vs LIKE-wildcard domain).
	for (const input of [
		{ kind: 'address' as const, value: 'not-an-address' },
		{ kind: 'domain' as const, value: 'user@example.com' },
		{ kind: 'domain' as const, value: 'bad%domain.com' },
	]) {
		await expect(
			upsertEmailSenderRule({
				db: env.APP_DB,
				userId,
				...input,
				effect: 'block',
			}),
		).rejects.toBeInstanceOf(EmailSenderRuleValidationError)
	}

	const capUserId = `rules-cap-${crypto.randomUUID()}`
	const timestamp = new Date().toISOString()
	for (let index = 0; index < maxEmailSenderRulesPerUser; index += 1) {
		await env.APP_DB.prepare(
			`INSERT INTO email_sender_rules (
				id, user_id, kind, value, effect, note, created_at, updated_at
			) VALUES (?, ?, 'domain', ?, 'block', '', ?, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				capUserId,
				`blocked-${String(index)}.example`,
				timestamp,
				timestamp,
			)
			.run()
	}
	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId: capUserId,
			kind: 'address',
			value: 'new@example.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleLimitError)
	const cappedUpdate = await upsertEmailSenderRule({
		db: env.APP_DB,
		userId: capUserId,
		kind: 'domain',
		value: 'blocked-0.example',
		effect: 'quarantine',
		note: 'still allowed to update',
	})
	expect(cappedUpdate.effect).toBe('quarantine')

	const otherId = `rules-other-${crypto.randomUUID()}`
	expect(
		await deleteEmailSenderRule({
			db: env.APP_DB,
			userId: otherId,
			ruleId: created.id,
		}),
	).toBe(false)
	expect(await listEmailSenderRules({ db: env.APP_DB, userId })).toHaveLength(1)
	expect(
		await deleteEmailSenderRule({
			db: env.APP_DB,
			userId,
			ruleId: created.id,
		}),
	).toBe(true)
	expect(await listEmailSenderRules({ db: env.APP_DB, userId })).toEqual([])
})

test('evaluateEmailSenderRules applies precedence and never matches across users', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `rules-eval-${crypto.randomUUID()}`
	const otherUserId = `rules-other-${crypto.randomUUID()}`
	for (const [kind, value, effect] of [
		['domain', 'example.com', 'block'],
		['domain', 'mail.example.com', 'quarantine'],
		['address', 'vip@mail.example.com', 'allow'],
	] as const) {
		await upsertEmailSenderRule({ db: env.APP_DB, userId, kind, value, effect })
	}

	// [evaluated user, sender, expected [effect, matched rule value] or null]
	const cases = [
		[userId, 'VIP@Mail.Example.COM', ['allow', 'vip@mail.example.com']],
		[userId, 'news@mail.example.com', ['quarantine', 'mail.example.com']],
		[userId, 'news@shop.example.com', ['block', 'example.com']],
		[userId, 'friend@other.example', null],
		[otherUserId, 'vip@mail.example.com', null],
		[otherUserId, 'news@mail.example.com', null],
	] as const
	const results = []
	for (const [evaluatedUserId, senderAddress] of cases) {
		const match = await evaluateEmailSenderRules({
			db: env.APP_DB,
			userId: evaluatedUserId,
			senderAddress,
		})
		results.push(match ? [match.effect, match.rule.value] : null)
	}
	expect(results).toEqual(cases.map(([, , expected]) => expected))
})
