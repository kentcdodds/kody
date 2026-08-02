import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { maxPlanEmailLimits, planLimits } from '#worker/entitlements/plans.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { emailUsageGetCapability } from './email-usage-get.ts'

async function seedUsageAccount(input: {
	email: string
	plan: 'pro' | 'max'
	emailVerifiedAt?: string | null
}) {
	await seedAccount({
		db: env.APP_DB,
		email: input.email,
		username: `email-usage-${crypto.randomUUID().slice(0, 8)}`,
		plan: input.plan,
		emailVerifiedAt: input.emailVerifiedAt,
	})
}

async function seedDailyCounter(input: {
	userId: string
	resource: 'email_sends_per_day' | 'email_receives_per_day'
	count: number
	day: string
}) {
	const meter = userMeterRpc({ env, userId: input.userId })
	await meter.initialize({
		resource: input.resource,
		day: input.day,
		count: input.count,
		updatedAt: new Date().toISOString(),
	})
}

async function seedStoredMessages(userId: string, count: number) {
	const now = new Date().toISOString()
	for (let index = 0; index < count; index += 1) {
		const id = `usage-message-${crypto.randomUUID()}`
		await mailboxRpc({ env, userId }).mirrorMessage({
			ownerId: userId,
			message: {
				id,
				direction: 'outbound',
				inboxId: null,
				threadId: null,
				senderIdentityId: null,
				fromAddress: 'owner@example.test',
				envelopeFrom: null,
				toAddresses: ['recipient@example.test'],
				ccAddresses: [],
				bccAddresses: [],
				replyToAddresses: [],
				subject: 'Stored',
				messageIdHeader: null,
				inReplyToHeader: null,
				references: [],
				headers: {},
				authResults: null,
				textBody: 'body',
				htmlBody: null,
				rawMimeKey: null,
				rawSize: 4,
				processingStatus: 'stored',
				classification: 'accepted',
				classificationReason: null,
				providerMessageId: null,
				deliveryStatus: null,
				deliveryStatusAt: null,
				error: null,
				receivedAt: null,
				sentAt: null,
				createdAt: now,
				updatedAt: now,
			},
		})
	}
}

function buildCallerContext(user: { userId: string; email: string } | null) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		...(user ? { user: { ...user, displayName: 'Usage Tester' } } : {}),
	})
}

test(
	'email_usage_get enforces auth and reads UserMeter-backed daily counts',
	{ timeout: 30_000 },
	async () => {
		await ensureEmailTestSchema(env.APP_DB)
		const day = utcDayKey()
		await expect(
			emailUsageGetCapability.handler(
				{},
				{ env, callerContext: buildCallerContext(null) },
			),
		).rejects.toThrow(/Authenticated MCP user/)

		const unverifiedEmail = `usage-unverified-${crypto.randomUUID()}@example.com`
		const unverifiedUserId = await createStableUserIdFromEmail(unverifiedEmail)
		await seedUsageAccount({
			email: unverifiedEmail,
			plan: 'max',
			emailVerifiedAt: null,
		})
		await expect(
			emailUsageGetCapability.handler(
				{},
				{
					env,
					callerContext: buildCallerContext({
						userId: unverifiedUserId,
						email: unverifiedEmail,
					}),
				},
			),
		).rejects.toThrow(/Account email is not verified/)

		const planEmail = `usage-plan-${crypto.randomUUID()}@example.com`
		const planUserId = await createStableUserIdFromEmail(planEmail)
		await seedUsageAccount({ email: planEmail, plan: 'pro' })
		await seedDailyCounter({
			userId: planUserId,
			resource: 'email_sends_per_day',
			count: 3,
			day,
		})
		await seedDailyCounter({
			userId: planUserId,
			resource: 'email_receives_per_day',
			count: 5,
			day,
		})
		await seedStoredMessages(planUserId, 2)

		const planResult = await emailUsageGetCapability.handler(
			{},
			{
				env,
				callerContext: buildCallerContext({
					userId: planUserId,
					email: planEmail,
				}),
			},
		)
		expect(planResult).toEqual({
			plan: 'pro',
			day,
			stored_messages: {
				count: 2,
				limit: planLimits.pro.maxStoredEmailMessages,
			},
			sends_today: { count: 3, limit: planLimits.pro.maxEmailSendsPerDay },
			receives_today: {
				count: 5,
				limit: planLimits.pro.maxEmailReceivesPerDay,
			},
			max_message_bytes: planLimits.pro.maxEmailMessageBytes,
		})
		const planMeter = userMeterRpc({ env, userId: planUserId })
		expect(
			await planMeter.read({ resource: 'email_sends_per_day', day }),
		).toMatchObject({ outcome: 'ready', count: 3 })
		expect(
			await planMeter.read({ resource: 'email_receives_per_day', day }),
		).toMatchObject({ outcome: 'ready', count: 5 })

		const maxEmail = `usage-max-${crypto.randomUUID()}@example.com`
		const maxUserId = await createStableUserIdFromEmail(maxEmail)
		await seedUsageAccount({ email: maxEmail, plan: 'max' })
		const maxResult = await emailUsageGetCapability.handler(
			{},
			{
				env,
				callerContext: buildCallerContext({
					userId: maxUserId,
					email: maxEmail,
				}),
			},
		)
		expect(maxResult).toEqual({
			plan: 'max',
			day,
			stored_messages: {
				count: 0,
				limit: maxPlanEmailLimits.stored_email_messages,
			},
			sends_today: {
				count: 0,
				limit: maxPlanEmailLimits.email_sends_per_day,
			},
			receives_today: {
				count: 0,
				limit: maxPlanEmailLimits.email_receives_per_day,
			},
			max_message_bytes: maxPlanEmailLimits.email_message_bytes,
		})

		const meterEmail = `usage-meter-${crypto.randomUUID()}@example.com`
		const meterUserId = await createStableUserIdFromEmail(meterEmail)
		await seedUsageAccount({ email: meterEmail, plan: 'pro' })
		await seedStoredMessages(meterUserId, 2)
		await seedDailyCounter({
			userId: meterUserId,
			resource: 'email_sends_per_day',
			count: 13,
			day,
		})
		await seedDailyCounter({
			userId: meterUserId,
			resource: 'email_receives_per_day',
			count: 15,
			day,
		})
		const meterResult = await emailUsageGetCapability.handler(
			{},
			{
				env,
				callerContext: buildCallerContext({
					userId: meterUserId,
					email: meterEmail,
				}),
			},
		)
		expect(meterResult.sends_today.count).toBe(13)
		expect(meterResult.receives_today.count).toBe(15)
		expect(meterResult.stored_messages.count).toBe(2)
	},
)
