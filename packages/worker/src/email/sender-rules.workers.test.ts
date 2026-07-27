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

test('upsertEmailSenderRule creates and updates by (kind, value)', async () => {
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
	expect(created.createdAt).toBeTruthy()
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

	const listed = await listEmailSenderRules({ db: env.APP_DB, userId })
	expect(listed).toHaveLength(1)
	expect(listed[0]?.id).toBe(created.id)
	expect(listed[0]?.effect).toBe('quarantine')
})

test('upsertEmailSenderRule rejects invalid address and domain values', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `rules-invalid-${crypto.randomUUID()}`

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'address',
			value: 'not-an-address',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'address',
			value: '@example.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'domain',
			value: 'user@example.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'domain',
			value: 'localhost',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'domain',
			value: 'bad domain.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'address',
			value: 'us er@example.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	// LIKE wildcards must never reach the stored value used in the
	// subdomain-suffix pattern.
	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'domain',
			value: 'bad%domain.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'domain',
			value: 'bad_domain.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleValidationError)

	expect(await listEmailSenderRules({ db: env.APP_DB, userId })).toEqual([])
})

test('upsertEmailSenderRule enforces the per-user cap on inserts only', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `rules-cap-${crypto.randomUUID()}`
	const timestamp = new Date().toISOString()

	for (let index = 0; index < maxEmailSenderRulesPerUser; index += 1) {
		await env.APP_DB.prepare(
			`INSERT INTO email_sender_rules (
				id, user_id, kind, value, effect, note, created_at, updated_at
			) VALUES (?, ?, 'domain', ?, 'block', '', ?, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				userId,
				`blocked-${String(index)}.example`,
				timestamp,
				timestamp,
			)
			.run()
	}

	await expect(
		upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind: 'address',
			value: 'new@example.com',
			effect: 'block',
		}),
	).rejects.toBeInstanceOf(EmailSenderRuleLimitError)

	const updated = await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'domain',
		value: 'blocked-0.example',
		effect: 'quarantine',
		note: 'still allowed to update',
	})
	expect(updated.effect).toBe('quarantine')
	expect(updated.note).toBe('still allowed to update')
})

test('deleteEmailSenderRule is scoped by userId', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const ownerId = `rules-owner-${crypto.randomUUID()}`
	const otherId = `rules-other-${crypto.randomUUID()}`

	const rule = await upsertEmailSenderRule({
		db: env.APP_DB,
		userId: ownerId,
		kind: 'domain',
		value: 'spam.example',
		effect: 'block',
	})

	expect(
		await deleteEmailSenderRule({
			db: env.APP_DB,
			userId: otherId,
			ruleId: rule.id,
		}),
	).toBe(false)
	expect(
		await listEmailSenderRules({ db: env.APP_DB, userId: ownerId }),
	).toHaveLength(1)

	expect(
		await deleteEmailSenderRule({
			db: env.APP_DB,
			userId: ownerId,
			ruleId: rule.id,
		}),
	).toBe(true)
	expect(
		await listEmailSenderRules({ db: env.APP_DB, userId: ownerId }),
	).toEqual([])
})

test('evaluateEmailSenderRules applies address, subdomain, and longest-domain precedence', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `rules-eval-${crypto.randomUUID()}`

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
	expect(addressWin?.rule.kind).toBe('address')
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
})

test('evaluateEmailSenderRules never matches another user rules', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userA = `rules-a-${crypto.randomUUID()}`
	const userB = `rules-b-${crypto.randomUUID()}`

	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId: userA,
		kind: 'address',
		value: 'blocked@example.com',
		effect: 'block',
	})
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId: userA,
		kind: 'domain',
		value: 'spam.example',
		effect: 'quarantine',
	})

	expect(
		await evaluateEmailSenderRules({
			db: env.APP_DB,
			userId: userB,
			senderAddress: 'blocked@example.com',
		}),
	).toBeNull()
	expect(
		await evaluateEmailSenderRules({
			db: env.APP_DB,
			userId: userB,
			senderAddress: 'bot@spam.example',
		}),
	).toBeNull()

	const ownerMatch = await evaluateEmailSenderRules({
		db: env.APP_DB,
		userId: userA,
		senderAddress: 'blocked@example.com',
	})
	expect(ownerMatch?.effect).toBe('block')
})
