import { expect, test } from 'vitest'
import { type SitePerfReport } from './collect.ts'
import {
	buildInvokeBody,
	defaultInvokeSource,
	defaultInvokeUrl,
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
	findings: [
		{
			id: 'home-no-store',
			message: 'Anonymous homepage HTML is Cache-Control: no-store.',
		},
	],
	verdict: 'needs-fix',
}

test('invoke gates on needs-fix and a token, and builds an idempotent body', async () => {
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
		source: defaultInvokeSource,
	})

	const fetchImpl = async () => {
		throw new Error('should not fetch')
	}
	expect(
		await invokeSitePerfPackage({
			report: { ...needsFixReport, verdict: 'ok' },
			token: 'token',
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'ok' })
	expect(
		await invokeSitePerfPackage({
			report: needsFixReport,
			token: undefined,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'missing-token' })
})

test('invoke posts the report, treats replay/in-progress as launched, and surfaces API errors', async () => {
	const calls: Array<{ url: string; auth: string | null; body: unknown }> = []
	const fetchImpl: typeof fetch = async (url, init) => {
		calls.push({
			url: String(url),
			auth: new Headers(init?.headers).get('Authorization'),
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
		token: 'kody_test',
		repository: 'kentcdodds/kody',
		startingRef: 'main',
		runId: '77',
		fetchImpl,
	})
	expect(calls).toEqual([
		{
			url: defaultInvokeUrl,
			auth: 'Bearer kody_test',
			body: buildInvokeBody({
				report: needsFixReport,
				repository: 'kentcdodds/kody',
				startingRef: 'main',
				runId: '77',
			}),
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
		token: 'kody_test',
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
		token: 'kody_test',
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
			token: 'kody_test',
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '88',
			fetchImpl: async () =>
				new Response('upstream unavailable', { status: 503 }),
		}),
	).rejects.toThrow(/Kody package invocation 503/)
})
