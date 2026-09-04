import { expect, test } from 'vitest'
import { type SitePerfReport } from './collect.ts'
import {
	buildInvokeBody,
	invokeSitePerfPackage,
	shouldInvokeSitePerfPackage,
} from './invoke-site-perf-package.ts'

const needsFixReport: SitePerfReport = {
	url: 'https://kody.codes/',
	fetchedAt: '2026-08-18T00:00:00.000Z',
	htmlBytes: 1200,
	cacheControl: 'no-store',
	vary: null,
	largestSameOriginJsBytes: 800,
	lcpImageBytes: 800,
	ttfbMs: 80,
	serverTiming: [{ name: 'ssr', durationMs: 20 }],
	pages: [],
	findings: [
		{
			id: 'home-no-store',
			message: 'Anonymous homepage HTML is Cache-Control: no-store.',
		},
	],
	verdict: 'needs-fix',
}

const exampleWebhookUrl = 'https://example.test/webhooks/weekly-site-perf/run'

test('invoke gates on needs-fix and a webhook URL, and builds a params body', async () => {
	expect(
		shouldInvokeSitePerfPackage({ ...needsFixReport, verdict: 'ok' }),
	).toBe(false)
	expect(shouldInvokeSitePerfPackage(needsFixReport)).toBe(true)
	expect(
		buildInvokeBody({
			report: needsFixReport,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '99',
		}),
	).toEqual({
		params: {
			report: needsFixReport,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
		},
		idempotencyKey: 'weekly-site-perf:99',
	})

	const fetchImpl = async () => {
		throw new Error('should not fetch')
	}
	expect(
		await invokeSitePerfPackage({
			report: { ...needsFixReport, verdict: 'ok' },
			webhookUrl: exampleWebhookUrl,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'ok' })
	expect(
		await invokeSitePerfPackage({
			report: needsFixReport,
			webhookUrl: undefined,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'missing-webhook-url' })
	expect(
		await invokeSitePerfPackage({
			report: needsFixReport,
			webhookUrl: '',
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'missing-webhook-url' })
})

test('invoke posts params to the webhook URL, treats replay/in-progress as launched, and surfaces API errors', async () => {
	const calls: Array<{
		url: string
		auth: string | null
		idempotencyKey: string | null
		body: unknown
	}> = []
	const fetchImpl: typeof fetch = async (url, init) => {
		const headers = new Headers(init?.headers)
		calls.push({
			url: String(url),
			auth: headers.get('Authorization'),
			idempotencyKey: headers.get('Idempotency-Key'),
			body: JSON.parse(String(init?.body)),
		})
		return new Response(
			JSON.stringify({
				ok: true,
				idempotency: { replayed: false },
				result: {
					agent: {
						id: 'bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
						url: 'https://cursor.com/agents/bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
					},
				},
			}),
			{ status: 200 },
		)
	}

	const invoked = await invokeSitePerfPackage({
		report: needsFixReport,
		webhookUrl: exampleWebhookUrl,
		repository: 'kentcdodds/kody',
		startingRef: 'main',
		runId: '77',
		fetchImpl,
	})
	expect(calls).toEqual([
		{
			url: exampleWebhookUrl,
			auth: null,
			idempotencyKey: 'weekly-site-perf:77',
			body: {
				params: {
					report: needsFixReport,
					repository: 'kentcdodds/kody',
					startingRef: 'main',
				},
				idempotencyKey: 'weekly-site-perf:77',
			},
		},
	])
	expect(invoked).toEqual({
		invoked: true,
		agentUrl:
			'https://cursor.com/agents/bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
		result: {
			agent: {
				id: 'bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
				url: 'https://cursor.com/agents/bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
			},
		},
	})

	const replayed = await invokeSitePerfPackage({
		report: needsFixReport,
		webhookUrl: exampleWebhookUrl,
		repository: 'kentcdodds/kody',
		startingRef: 'main',
		runId: '77',
		fetchImpl: async () =>
			new Response(
				JSON.stringify({
					ok: true,
					idempotency: { replayed: true },
					result: { skipped: false },
				}),
				{ status: 200 },
			),
	})
	expect(replayed).toMatchObject({ invoked: true, replayed: true })

	const inProgress = await invokeSitePerfPackage({
		report: needsFixReport,
		webhookUrl: exampleWebhookUrl,
		repository: 'kentcdodds/kody',
		startingRef: 'main',
		runId: '77',
		fetchImpl: async () =>
			new Response(
				JSON.stringify({
					ok: false,
					error: { code: 'invocation_in_progress' },
				}),
				{ status: 409 },
			),
	})
	expect(inProgress).toMatchObject({ invoked: true, inProgress: true })

	await expect(
		invokeSitePerfPackage({
			report: needsFixReport,
			webhookUrl: exampleWebhookUrl,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '88',
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						ok: false,
						error: { code: 'idempotency_mismatch' },
					}),
					{ status: 409 },
				),
		}),
	).rejects.toThrow(/Kody webhook idempotency mismatch/)

	await expect(
		invokeSitePerfPackage({
			report: needsFixReport,
			webhookUrl: exampleWebhookUrl,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '88',
			fetchImpl: async () =>
				new Response('upstream unavailable', { status: 503 }),
		}),
	).rejects.toThrow(/Kody webhook 503/)
})
