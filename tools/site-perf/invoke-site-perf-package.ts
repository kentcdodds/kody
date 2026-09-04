import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { isExecutedDirectly } from '../node-runtime.ts'
import { type SitePerfReport } from './collect.ts'
import { needsFixTitle } from './upsert-github-issue.ts'

export function shouldInvokeSitePerfPackage(report: SitePerfReport) {
	return report.verdict === 'needs-fix'
}

export function buildInvokeBody(input: {
	report: SitePerfReport
	repository: string
	startingRef: string
	runId: string
}) {
	return {
		params: {
			report: input.report,
			repository: input.repository,
			startingRef: input.startingRef,
		},
		idempotencyKey: `weekly-site-perf:${input.runId}`,
	}
}

export type InvokeSitePerfPackageResult =
	| { skipped: 'ok' | 'missing-webhook-url' }
	| {
			invoked: true
			replayed?: true
			inProgress?: true
			agentUrl?: string
			result: unknown
	  }

function agentUrlFromResult(result: unknown): string | undefined {
	if (!result || typeof result !== 'object') return undefined
	const record = result as {
		agent?: { url?: string; id?: string }
		url?: string
	}
	if (typeof record.agent?.url === 'string') return record.agent.url
	if (typeof record.url === 'string') return record.url
	if (typeof record.agent?.id === 'string') {
		return `https://cursor.com/agents/${record.agent.id}`
	}
	return undefined
}

export async function invokeSitePerfPackage(input: {
	report: SitePerfReport
	webhookUrl: string | undefined
	repository: string
	startingRef: string
	runId: string
	fetchImpl?: typeof fetch
}): Promise<InvokeSitePerfPackageResult> {
	if (!shouldInvokeSitePerfPackage(input.report)) {
		return { skipped: 'ok' }
	}
	if (!input.webhookUrl) {
		return { skipped: 'missing-webhook-url' }
	}

	const body = buildInvokeBody(input)
	const response = await (input.fetchImpl ?? fetch)(input.webhookUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Idempotency-Key': body.idempotencyKey,
		},
		body: JSON.stringify(body),
	})

	const detail = await response.text()
	let payload: {
		ok?: boolean
		result?: unknown
		idempotency?: { replayed?: boolean }
		error?: { code?: string; message?: string }
	} = {}
	try {
		payload = JSON.parse(detail) as typeof payload
	} catch {
		payload = {}
	}

	if (response.status === 409) {
		if (payload.error?.code === 'invocation_in_progress') {
			return {
				invoked: true,
				inProgress: true,
				result: payload,
			}
		}
		if (payload.error?.code === 'idempotency_mismatch') {
			throw new Error(
				`Kody webhook idempotency mismatch: ${detail.slice(0, 2000)}`,
			)
		}
	}

	if (!response.ok) {
		throw new Error(`Kody webhook ${response.status}: ${detail.slice(0, 2000)}`)
	}

	return {
		invoked: true,
		replayed: payload.idempotency?.replayed === true ? true : undefined,
		agentUrl: agentUrlFromResult(payload.result),
		result: payload.result ?? payload,
	}
}

function commentOnNeedsFixIssue(agentUrl: string) {
	const listed = spawnSync(
		'gh',
		[
			'issue',
			'list',
			'--search',
			`in:title "${needsFixTitle}"`,
			'--state',
			'open',
			'--json',
			'number,title',
		],
		{ encoding: 'utf8' },
	)
	if (listed.status !== 0) return
	const issues = JSON.parse(listed.stdout) as Array<{
		number: number
		title: string
	}>
	const issue = issues.find((row) => row.title === needsFixTitle)
	if (!issue) return
	spawnSync(
		'gh',
		[
			'issue',
			'comment',
			String(issue.number),
			'--body',
			`Invoked the weekly-site-perf Kody package. Cursor agent: ${agentUrl}`,
		],
		{ encoding: 'utf8' },
	)
}

export async function main(argv = process.argv.slice(2)) {
	const reportPath = argv[0] ?? 'site-perf-report.json'
	const report = JSON.parse(
		await readFile(reportPath, 'utf8'),
	) as SitePerfReport
	const result = await invokeSitePerfPackage({
		report,
		webhookUrl: process.env.KODY_WEBHOOK_URL_RUN,
		repository: process.env.GITHUB_REPOSITORY ?? 'kentcdodds/kody',
		startingRef: process.env.SITE_PERF_STARTING_REF ?? 'main',
		runId: process.env.GITHUB_RUN_ID ?? 'local',
	})
	process.stdout.write(`${JSON.stringify(result)}\n`)
	if (
		'invoked' in result &&
		result.invoked &&
		result.agentUrl &&
		process.env.GH_TOKEN
	) {
		commentOnNeedsFixIssue(result.agentUrl)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
}
