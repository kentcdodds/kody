import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { isExecutedDirectly } from '../node-runtime.ts'
import { type SitePerfReport } from './collect.ts'
import { actionableTitle } from './upsert-github-issue.ts'

export const cursorAgentsUrl = 'https://api.cursor.com/v1/agents'

export function shouldLaunchCloudAgent(
	report: SitePerfReport,
): report is SitePerfReport & { verdict: 'actionable' } {
	return report.verdict === 'actionable'
}

/**
 * Stable `bc-<uuid>` so a retried workflow job does not start a second agent.
 * `envVars` cannot be sent on the same create as `agentId`.
 */
export function agentIdForRun(runId: string) {
	const hex = createHash('sha256')
		.update(`kody-weekly-site-perf:${runId}`)
		.digest('hex')
	const bytes = Buffer.from(hex.slice(0, 32), 'hex')
	bytes[6] = (bytes[6]! & 0x0f) | 0x50
	bytes[8] = (bytes[8]! & 0x3f) | 0x80
	const h = bytes.toString('hex')
	return `bc-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export function buildSitePerfAgentPrompt(report: SitePerfReport) {
	const findings =
		report.findings.length === 0
			? '- none'
			: report.findings
					.map(
						(finding) =>
							`- **${finding.severity}** \`${finding.id}\`: ${finding.message}`,
					)
					.join('\n')
	return [
		'Weekly production landing-page performance cleanup for https://kody.codes/.',
		'',
		'The GitHub Action already measured and classified. Do not re-litigate the',
		'verdict. Implement only the listed findings. Do not invent a redesign.',
		'',
		`Verdict: **${report.verdict}**`,
		`URL: ${report.url}`,
		`Fetched: ${report.fetchedAt}`,
		`HTML: ${report.htmlBytes} bytes`,
		`Largest same-origin JS: ${report.largestSameOriginJsBytes ?? 'n/a'} bytes`,
		`LCP image: ${report.lcpImageBytes ?? 'n/a'} bytes`,
		`Cache-Control: ${report.cacheControl ?? 'n/a'}`,
		'',
		'Findings:',
		findings,
		'',
		'```json',
		JSON.stringify(report, null, 2),
		'```',
		'',
		'Owners for the usual findings:',
		'- LCP / srcset / mark bytes → `packages/worker/universal/landing-images.ts`, `packages/worker/public/images/`, `ssr-document.tsx`',
		'- Anonymous HTML cache → `packages/worker/src/app/anonymous-html-cache.ts`',
		'- First-paint third parties → `deferred-turnstile.ts`, homepage waitlist',
		'- Landing CSS / HTML weight → `packages/worker/public/styles.css`, `packages/worker/client/routes/home.tsx`',
		'- Entry JS / Shiki leak → `lazy-route.tsx`, `tools/build-client-manifest.ts`',
		'',
		'Verify with focused Vitest for the files you touch, then `npm run site-perf -- --url https://kody.codes/ --json` only after deploy (local collect still hits production).',
		'If the fix is no longer local or verify fails, stop and leave the tracking issue open. Do not auto-merge high-risk work.',
		'',
		'Then follow `.agents/skills/ship-pr/SKILL.md`: ready-for-review, wait for CI, medium-risk AI reviewers, squash-merge when policy allows.',
	].join('\n')
}

export type CreateCloudAgentBody = {
	agentId: string
	name: string
	prompt: { text: string }
	repos: Array<{ url: string; startingRef: string }>
	autoCreatePR: true
	skipReviewerRequest: true
	workOnCurrentBranch: false
}

export function buildCreateAgentBody(input: {
	report: SitePerfReport
	repository: string
	startingRef: string
	runId: string
}): CreateCloudAgentBody {
	return {
		agentId: agentIdForRun(input.runId),
		name: `Weekly site perf (${input.report.verdict})`,
		prompt: { text: buildSitePerfAgentPrompt(input.report) },
		repos: [
			{
				url: `https://github.com/${input.repository}`,
				startingRef: input.startingRef,
			},
		],
		autoCreatePR: true,
		skipReviewerRequest: true,
		workOnCurrentBranch: false,
	}
}

export type LaunchCloudAgentResult =
	| { skipped: 'ok' | 'human' | 'missing-api-key' }
	| { launched: true; agentId: string; url: string; alreadyExists?: true }

export async function launchSitePerfCloudAgent(input: {
	report: SitePerfReport
	apiKey: string | undefined
	repository: string
	startingRef: string
	runId: string
	fetchImpl?: typeof fetch
}): Promise<LaunchCloudAgentResult> {
	if (!shouldLaunchCloudAgent(input.report)) {
		return { skipped: input.report.verdict }
	}
	if (!input.apiKey) {
		return { skipped: 'missing-api-key' }
	}

	const body = buildCreateAgentBody(input)
	const response = await (input.fetchImpl ?? fetch)(cursorAgentsUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${input.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (response.status === 409) {
		return {
			launched: true,
			alreadyExists: true,
			agentId: body.agentId,
			url: `https://cursor.com/agents/${body.agentId}`,
		}
	}

	if (!response.ok) {
		const detail = await response.text()
		throw new Error(
			`Cursor Cloud Agents API ${response.status}: ${detail.slice(0, 2000)}`,
		)
	}

	const payload = (await response.json()) as {
		agent?: { id?: string; url?: string }
	}
	const agentId = payload.agent?.id ?? body.agentId
	const url = payload.agent?.url ?? `https://cursor.com/agents/${agentId}`
	return { launched: true, agentId, url }
}

function commentOnActionableIssue(agentUrl: string) {
	const listed = spawnSync(
		'gh',
		[
			'issue',
			'list',
			'--search',
			`in:title "${actionableTitle}"`,
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
	const issue = issues.find((row) => row.title === actionableTitle)
	if (!issue) return
	spawnSync(
		'gh',
		[
			'issue',
			'comment',
			String(issue.number),
			'--body',
			`Launched a Cursor cloud agent to implement the findings: ${agentUrl}`,
		],
		{ encoding: 'utf8' },
	)
}

export async function main(argv = process.argv.slice(2)) {
	const reportPath = argv[0] ?? 'site-perf-report.json'
	const report = JSON.parse(
		await readFile(reportPath, 'utf8'),
	) as SitePerfReport
	const result = await launchSitePerfCloudAgent({
		report,
		apiKey: process.env.CURSOR_API_KEY,
		repository: process.env.GITHUB_REPOSITORY ?? 'kentcdodds/kody',
		startingRef: process.env.SITE_PERF_STARTING_REF ?? 'main',
		runId: process.env.GITHUB_RUN_ID ?? 'local',
	})
	process.stdout.write(`${JSON.stringify(result)}\n`)
	if ('launched' in result && result.launched && process.env.GH_TOKEN) {
		commentOnActionableIssue(result.url)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
}
