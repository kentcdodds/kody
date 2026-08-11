import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { systemEmailDayKey, systemEmailLimits } from './system-email.ts'
import { sendSystemEmail } from './system-outbound.ts'

const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

const mswOptions = { onUnhandledRequest: 'bypass' as const }

function createSystemEnv() {
	return {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
		SYSTEM_EMAIL_DOMAIN: 'kody.example.com',
		CLOUDFLARE_ACCOUNT_ID: 'account-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'token-123',
	}
}

async function readSendCounter(localPart: string, now = new Date()) {
	const row = await env.APP_DB.prepare(
		`SELECT count FROM system_email_daily_counters
		WHERE local_part = ? AND day = ?`,
	)
		.bind(`send:${localPart}`, systemEmailDayKey(now))
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

test('sendSystemEmail sends from the reserved system sender to external recipients', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-03-04T05:06:07.000Z')
	const payloads: Array<Record<string, unknown>> = []
	using _server = createMswNodeServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				payloads.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: { message_id: 'system-message-1' },
				})
			}),
		],
		mswOptions,
	)

	const result = await sendSystemEmail({
		env: createSystemEnv(),
		to: ['Reporter@Example.com', 'reporter@example.com'],
		subject: '  Thanks for the report  ',
		text: 'We shipped the fix.',
		replyTo: 'support@kody.example.com',
		now,
	})

	expect(result).toEqual({
		from: 'kody@kody.example.com',
		to: ['reporter@example.com'],
		providerMessageId: 'system-message-1',
	})
	expect(payloads).toEqual([
		expect.objectContaining({
			from: 'kody@kody.example.com',
			to: 'reporter@example.com',
			subject: 'Thanks for the report',
			text: 'We shipped the fix.',
			html: '<!doctype html><html lang="en"><body><p>We shipped the fix.</p></body></html>',
			replyTo: 'support@kody.example.com',
		}),
	])
	expect(await readSendCounter('kody', now)).toBe(1)
})

test('sendSystemEmail rejects unusable senders, recipients, and bodies', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	using _server = createMswNodeServer(
		[
			http.post(cloudflareEmailApi, () => {
				throw new Error('Send should not be attempted')
			}),
		],
		mswOptions,
	)

	await expect(
		sendSystemEmail({
			env: createSystemEnv(),
			localPart: 'marketing' as 'kody',
			to: 'reporter@example.com',
			subject: 'Hi',
			text: 'Body',
		}),
	).rejects.toThrow('Unknown system sender "marketing"')

	await expect(
		sendSystemEmail({
			env: createSystemEnv(),
			to: 'not-an-address',
			subject: 'Hi',
			text: 'Body',
		}),
	).rejects.toThrow('Invalid recipient email address: not-an-address')

	await expect(
		sendSystemEmail({
			env: createSystemEnv(),
			to: Array.from({ length: 6 }, (_, index) => `r${index}@example.com`),
			subject: 'Hi',
			text: 'Body',
		}),
	).rejects.toThrow('at most 5 recipients')

	await expect(
		sendSystemEmail({
			env: createSystemEnv(),
			to: 'reporter@example.com',
			subject: '   ',
			text: 'Body',
		}),
	).rejects.toThrow('Email subject is required.')

	await expect(
		sendSystemEmail({
			env: createSystemEnv(),
			to: 'reporter@example.com',
			subject: 'Hi',
		}),
	).rejects.toThrow('Email text or HTML body is required.')

	await expect(
		sendSystemEmail({
			env: { ...createSystemEnv(), APP_BASE_URL: '', SYSTEM_EMAIL_DOMAIN: '' },
			to: 'reporter@example.com',
			subject: 'Hi',
			text: 'Body',
		}),
	).rejects.toThrow('no system email domain is configured')
})

test('a failed provider call refunds the daily send budget and the cap blocks further sends', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	// The provider client warns on an API error response; that is the
	// behavior under test here.
	consoleWarn.mockImplementation(() => {})
	const now = new Date('2026-03-05T05:06:07.000Z')
	using _server = createMswNodeServer(
		[
			http.post(cloudflareEmailApi, () =>
				HttpResponse.json(
					{ success: false, errors: [{ message: 'Recipient rejected' }] },
					{ status: 400 },
				),
			),
		],
		mswOptions,
	)

	await expect(
		sendSystemEmail({
			env: createSystemEnv(),
			localPart: 'support',
			to: 'reporter@example.com',
			subject: 'Hi',
			text: 'Body',
			now,
		}),
	).rejects.toThrow('Recipient rejected')
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.stringContaining('Recipient rejected'),
	)
	expect(await readSendCounter('support', now)).toBe(0)

	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(local_part, day) DO UPDATE SET count = excluded.count`,
	)
		.bind(
			'send:support',
			systemEmailDayKey(now),
			systemEmailLimits.maxSendsPerDay,
			now.toISOString(),
		)
		.run()

	await expect(
		sendSystemEmail({
			env: createSystemEnv(),
			localPart: 'support',
			to: 'reporter@example.com',
			subject: 'Hi',
			text: 'Body',
			now,
		}),
	).rejects.toThrow('Daily system email send limit reached')
	// Receives keep their own budget: the send cap never blocks inbound mail.
	expect(
		await env.APP_DB.prepare(
			`SELECT count FROM system_email_daily_counters
			WHERE local_part = 'support' AND day = ?`,
		)
			.bind(systemEmailDayKey(now))
			.first(),
	).toBeNull()
})
