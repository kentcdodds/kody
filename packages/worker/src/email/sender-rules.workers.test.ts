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

	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'domain',
		value: 'example.com',
		effect: 'block',
	})
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'domain',
		value: 'mail.example.com',
		effect: 'quarantine',
	})
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'vip@mail.example.com',
		effect: 'allow',
	})

	const addressWin = await evaluateEmailSenderRules({
		db: env.APP_DB,
		userId,
		senderAddress: 'VIP@Mail.Example.COM',
	})
	expect(addressWin?.effect).toBe('allow')
	expect(addressWin?.rule.value).toBe('vip@mail.example.com')

	const longestDomain = await evaluateEmailSenderRules({
		db: env.APP_DB,
		userId,
		senderAddress: 'news@mail.example.com',
	})
	expect(longestDomain?.effect).toBe('quarantine')
	expect(longestDomain?.rule.value).toBe('mail.example.com')

	const parentDomain = await evaluateEmailSenderRules({
		db: env.APP_DB,
		userId,
		senderAddress: 'news@shop.example.com',
	})
	expect(parentDomain?.effect).toBe('block')
	expect(parentDomain?.rule.value).toBe('example.com')

	expect(
		await evaluateEmailSenderRules({
			db: env.APP_DB,
			userId,
			senderAddress: 'friend@other.example',
		}),
	).toBeNull()

	expect(
		await evaluateEmailSenderRules({
			db: env.APP_DB,
			userId: otherUserId,
			senderAddress: 'vip@mail.example.com',
		}),
	).toBeNull()
	expect(
		await evaluateEmailSenderRules({
			db: env.APP_DB,
			userId: otherUserId,
			senderAddress: 'news@mail.example.com',
		}),
	).toBeNull()
})
