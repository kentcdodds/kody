import { expect, test } from 'vitest'
import { type SitePerfReport } from './collect.ts'
import {
	agentIdForRun,
	buildCreateAgentBody,
	buildSitePerfAgentPrompt,
	cursorAgentsUrl,
	launchSitePerfCloudAgent,
	shouldLaunchCloudAgent,
} from './launch-cloud-agent.ts'

const actionableReport: SitePerfReport = {
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
			severity: 'actionable',
			message: 'Anonymous homepage HTML is Cache-Control: no-store.',
		},
	],
	verdict: 'actionable',
}

test('only an actionable verdict launches a cloud agent', () => {
	expect(shouldLaunchCloudAgent({ ...actionableReport, verdict: 'ok' })).toBe(
		false,
	)
	expect(
		shouldLaunchCloudAgent({ ...actionableReport, verdict: 'human' }),
	).toBe(false)
	expect(shouldLaunchCloudAgent(actionableReport)).toBe(true)
})

test('agent id is a stable bc-uuid for the same run', () => {
	const first = agentIdForRun('123')
	const second = agentIdForRun('123')
	expect(first).toBe(second)
	expect(first).toMatch(
		/^bc-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	)
	expect(agentIdForRun('124')).not.toBe(first)
})

test('create body points at the repo, opens a PR, and embeds the report', () => {
	const body = buildCreateAgentBody({
		report: actionableReport,
		repository: 'kentcdodds/kody',
		startingRef: 'main',
		runId: '99',
	})
	expect(body.repos).toEqual([
		{ url: 'https://github.com/kentcdodds/kody', startingRef: 'main' },
	])
	expect(body.autoCreatePR).toBe(true)
	expect(body.workOnCurrentBranch).toBe(false)
	expect(body.prompt.text).toContain('home-no-store')
	expect(body.prompt.text).toContain('ship-pr')
	expect(buildSitePerfAgentPrompt(actionableReport)).toContain(
		'"verdict": "actionable"',
	)
})

test('launch skips ok, human, and a missing API key', async () => {
	const fetchImpl = async () => {
		throw new Error('should not fetch')
	}
	expect(
		await launchSitePerfCloudAgent({
			report: { ...actionableReport, verdict: 'ok' },
			apiKey: 'key',
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'ok' })
	expect(
		await launchSitePerfCloudAgent({
			report: { ...actionableReport, verdict: 'human' },
			apiKey: 'key',
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'human' })
	expect(
		await launchSitePerfCloudAgent({
			report: actionableReport,
			apiKey: undefined,
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '1',
			fetchImpl,
		}),
	).toEqual({ skipped: 'missing-api-key' })
})

test('launch posts to the Cloud Agents API and treats 409 as already launched', async () => {
	const calls: Array<{ url: string; auth: string | null }> = []
	const fetchImpl: typeof fetch = async (url, init) => {
		calls.push({
			url: String(url),
			auth: new Headers(init?.headers).get('Authorization'),
		})
		return new Response(
			JSON.stringify({
				agent: {
					id: 'bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
					url: 'https://cursor.com/agents/bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
				},
			}),
			{ status: 201 },
		)
	}

	const launched = await launchSitePerfCloudAgent({
		report: actionableReport,
		apiKey: 'crsr_test',
		repository: 'kentcdodds/kody',
		startingRef: 'main',
		runId: '77',
		fetchImpl,
	})
	expect(calls).toEqual([{ url: cursorAgentsUrl, auth: 'Bearer crsr_test' }])
	expect(launched).toEqual({
		launched: true,
		agentId: 'bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
		url: 'https://cursor.com/agents/bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
	})

	const conflict: typeof fetch = async () =>
		new Response('{"error":{"code":"agent_id_conflict"}}', { status: 409 })
	const retry = await launchSitePerfCloudAgent({
		report: actionableReport,
		apiKey: 'crsr_test',
		repository: 'kentcdodds/kody',
		startingRef: 'main',
		runId: '77',
		fetchImpl: conflict,
	})
	expect(retry).toMatchObject({
		launched: true,
		alreadyExists: true,
		agentId: agentIdForRun('77'),
	})
})

test('launch throws when the Cloud Agents API returns an error', async () => {
	const fetchImpl: typeof fetch = async () =>
		new Response('upstream unavailable', { status: 503 })
	await expect(
		launchSitePerfCloudAgent({
			report: actionableReport,
			apiKey: 'crsr_test',
			repository: 'kentcdodds/kody',
			startingRef: 'main',
			runId: '88',
			fetchImpl,
		}),
	).rejects.toThrow(/Cloud Agents API 503/)
})
