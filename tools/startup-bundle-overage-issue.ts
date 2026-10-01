import { spawnSync } from 'node:child_process'

export type StartupBundleOverageName = 'origin' | 'platform' | 'runtime'

export type StartupBundleOverage = {
	name: StartupBundleOverageName
	size: number
	maxEntryBytes: number
	overage: number
}

export type StartupBundleOverageIssueAction =
	| { action: 'created'; name: StartupBundleOverageName; url: string }
	| { action: 'updated'; name: StartupBundleOverageName; number: number }
	| { action: 'skipped'; name: StartupBundleOverageName; reason: string }

export const startupBundleOverageIssueLabel = 'friction'

export function startupBundleOverageIssueTitle(name: StartupBundleOverageName) {
	return `Startup budget overage: ${name}`
}

export function startupBundleOverageIssueMarker(
	name: StartupBundleOverageName,
) {
	return `<!-- kody-startup-bundle-overage:${name} -->`
}

export function formatStartupBundleBytes(bytes: number) {
	return bytes.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_')
}

export function formatStartupBundleOverageWarning(
	overage: StartupBundleOverage,
) {
	return (
		`${overage.name} startup entry is ${formatStartupBundleBytes(overage.size)} bytes, ` +
		`${formatStartupBundleBytes(overage.overage)} over its ` +
		`${formatStartupBundleBytes(overage.maxEntryBytes)}-byte reviewed budget ` +
		`(warning only; does not fail CI).`
	)
}

export function buildStartupBundleOverageIssueBody(
	overage: StartupBundleOverage,
	context: {
		sha?: string | null
		runUrl?: string | null
		ref?: string | null
	} = {},
) {
	const lines = [
		startupBundleOverageIssueMarker(overage.name),
		'',
		`The **${overage.name}** Worker startup entry measured above its reviewed byte budget.`,
		'',
		`- Measured: \`${formatStartupBundleBytes(overage.size)}\` bytes`,
		`- Reviewed budget: \`${formatStartupBundleBytes(overage.maxEntryBytes)}\` bytes`,
		`- Overage: \`${formatStartupBundleBytes(overage.overage)}\` bytes`,
		'',
		'This no longer fails ✅ Validate / 🧹 Static or blocks 🚀 Deploy. Track the growth here, then either:',
		'',
		'1. Shrink the startup graph (preferred), or',
		'2. Raise `tools/worker-startup-bundle-budget.json` and append a note in `tools/worker-startup-bundle-notes.md`.',
		'',
	]
	if (context.sha) {
		lines.push(`- SHA: \`${context.sha}\``)
	}
	if (context.ref) {
		lines.push(`- Ref: \`${context.ref}\``)
	}
	if (context.runUrl) {
		lines.push(`- CI run: ${context.runUrl}`)
	}
	lines.push('')
	return `${lines.join('\n').trimEnd()}\n`
}

export function shouldReportStartupBundleOverageIssue(
	env: NodeJS.ProcessEnv = process.env,
) {
	const token = env.GH_TOKEN ?? env.GITHUB_TOKEN
	if (!token) return false
	if (env.CI !== '1' && env.CI !== 'true') return false
	if (env.GITHUB_EVENT_NAME !== 'push') return false
	const ref = env.GITHUB_REF ?? ''
	const refName = env.GITHUB_REF_NAME ?? ''
	return ref === 'refs/heads/main' || refName === 'main'
}

export const startupBundleOverageGhTimeoutMs = 10_000

function runGh(args: Array<string>, env: NodeJS.ProcessEnv = process.env) {
	const result = spawnSync('gh', args, {
		encoding: 'utf8',
		env,
		timeout: startupBundleOverageGhTimeoutMs,
		killSignal: 'SIGKILL',
	})
	if (result.error) {
		throw result.error
	}
	if (result.status !== 0) {
		throw new Error(result.stderr || `gh ${args.join(' ')} failed`)
	}
	return result.stdout
}

function findOpenOverageIssue(
	name: StartupBundleOverageName,
	env: NodeJS.ProcessEnv = process.env,
	gh: typeof runGh = runGh,
) {
	const title = startupBundleOverageIssueTitle(name)
	const marker = startupBundleOverageIssueMarker(name)
	const raw = gh(
		[
			'issue',
			'list',
			'--state',
			'open',
			'--limit',
			'50',
			'--json',
			'number,title,body',
			'--search',
			`("${title}" in:title) OR ("${marker}" in:body)`,
		],
		env,
	)
	const issues = JSON.parse(raw) as Array<{
		number: number
		title: string
		body: string | null
	}>
	return (
		issues.find((issue) => issue.title === title) ??
		issues.find((issue) => issue.body?.includes(marker) ?? false) ??
		null
	)
}

export function resolveStartupBundleOverageRunUrl(
	env: NodeJS.ProcessEnv = process.env,
) {
	if (env.GITHUB_RUN_URL) return env.GITHUB_RUN_URL
	const server = env.GITHUB_SERVER_URL
	const repo = env.GITHUB_REPOSITORY
	const runId = env.GITHUB_RUN_ID
	if (server && repo && runId) {
		return `${server.replace(/\/$/, '')}/${repo}/actions/runs/${runId}`
	}
	return null
}

export function upsertStartupBundleOverageIssue(
	overage: StartupBundleOverage,
	options: {
		env?: NodeJS.ProcessEnv
		sha?: string | null
		runUrl?: string | null
		ref?: string | null
		gh?: typeof runGh
		findOpen?: typeof findOpenOverageIssue
	} = {},
): StartupBundleOverageIssueAction {
	const env = options.env ?? process.env
	if (!shouldReportStartupBundleOverageIssue(env)) {
		return {
			action: 'skipped',
			name: overage.name,
			reason: 'issue reporting is only enabled on main CI pushes with GH_TOKEN',
		}
	}
	const gh = options.gh ?? runGh
	const findOpen = options.findOpen ?? findOpenOverageIssue
	const body = buildStartupBundleOverageIssueBody(overage, {
		sha: options.sha ?? env.GITHUB_SHA ?? null,
		runUrl: options.runUrl ?? resolveStartupBundleOverageRunUrl(env),
		ref: options.ref ?? env.GITHUB_REF ?? env.GITHUB_REF_NAME ?? null,
	})
	const existing = findOpen(overage.name, env, gh)
	if (existing) {
		gh(['issue', 'edit', String(existing.number), '--body', body], env)
		gh(
			[
				'issue',
				'comment',
				String(existing.number),
				'--body',
				formatStartupBundleOverageWarning(overage),
			],
			env,
		)
		return { action: 'updated', name: overage.name, number: existing.number }
	}
	const created = gh(
		[
			'issue',
			'create',
			'--title',
			startupBundleOverageIssueTitle(overage.name),
			'--body',
			body,
			'--label',
			startupBundleOverageIssueLabel,
		],
		env,
	)
	return { action: 'created', name: overage.name, url: created.trim() }
}

export function reportStartupBundleOverages(
	overages: ReadonlyArray<StartupBundleOverage>,
	options: {
		env?: NodeJS.ProcessEnv
		upsert?: typeof upsertStartupBundleOverageIssue
		log?: (message: string) => void
	} = {},
) {
	const log = options.log ?? console.warn
	const upsert = options.upsert ?? upsertStartupBundleOverageIssue
	const actions: Array<StartupBundleOverageIssueAction> = []
	for (const overage of overages) {
		log(formatStartupBundleOverageWarning(overage))
		try {
			const action = upsert(overage, { env: options.env })
			actions.push(action)
			if (action.action === 'created') {
				log(`Opened startup budget overage issue: ${action.url}`)
			} else if (action.action === 'updated') {
				log(
					`Updated startup budget overage issue #${String(action.number)} for ${action.name}`,
				)
			} else {
				log(
					`Skipped startup budget overage issue for ${action.name}: ${action.reason}`,
				)
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log(
				`Failed to upsert startup budget overage issue for ${overage.name}: ${message}`,
			)
			actions.push({
				action: 'skipped',
				name: overage.name,
				reason: message,
			})
		}
	}
	return actions
}
