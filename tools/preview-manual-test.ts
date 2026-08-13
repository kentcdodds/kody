import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { usernameFromEmail } from '../packages/worker/src/identity/username.ts'
import { runtimeWorkerHealthPath } from '../packages/shared/src/runtime-worker.ts'
import { isExecutedDirectly } from './node-runtime.ts'

const execFileAsync = promisify(execFile)

export const previewCommentMarker = '<!-- kody-preview-url -->'
export const previewSeedEmail = 'me@kentcdodds.com'
export const previewSeedPassword = 'ilikecode'
export const defaultWaitTimeoutMs = 15 * 60 * 1000
export const defaultPollIntervalMs = 8_000
export const defaultRequestTimeoutMs = 10_000

const usageLines = [
	'Usage: node tools/preview-manual-test.ts [options]',
	'',
	"Discover this PR's Cloudflare preview, wait until it is serving the",
	'deployed commit, sign in as the seeded user, then run authenticated',
	'requests so you can create specific data and assert the change.',
	'Use on medium-to-high risk PRs after pushing.',
	'',
	'Options:',
	'  --pr <n>            PR number (default: gh pr view)',
	'  --url <url>         Skip GitHub discovery; smoke this preview URL',
	'  --sha <sha>         Expected /health commitSha (default: GitHub',
	'                      preview deployment SHA, not local HEAD — see docs)',
	'  --no-wait           Fail immediately if the preview is not ready',
	'  --timeout-ms <n>    Wait budget in milliseconds (default: 900000)',
	'  --poll-ms <n>       Poll interval in milliseconds (default: 8000)',
	'  --skip-login        Skip POST /auth and cookie-backed checks',
	'  --request <spec>    Authenticated HTTP as the seed user (repeatable).',
	'                      Spec: METHOD /path [status] [json-body]',
	'                      Default success is any 2xx. Example:',
	'                      POST /account/values.json {"action":"save",...}',
	'  --check <path>      Extra authenticated GET after login (repeatable)',
	'  --cookie-file <p>   Write the session Cookie header value to a file',
	'  --json              Machine-readable output on stdout (includes',
	'                      session.cookieHeader for follow-up curl)',
	'  --help              Print this help',
	'',
	'Docs: docs/contributing/preview-manual-testing.md',
]

export type PreviewManualTestOptions = {
	prNumber: number | null
	previewUrl: string | null
	expectedSha: string | null
	wait: boolean
	timeoutMs: number
	pollIntervalMs: number
	skipLogin: boolean
	checkPaths: Array<string>
	sessionRequests: Array<SessionRequestSpec>
	cookieFile: string | null
	json: boolean
	help: boolean
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type SessionRequestSpec = {
	method: HttpMethod
	path: string
	expectedStatus: number | null
	body: unknown | null
}

export type ParsedPreviewComment = {
	previewUrl: string | null
	workerName: string | null
	runtimeWorkerName: string | null
	runtimeUrl: string | null
	d1DatabaseName: string | null
	oauthKvTitle: string | null
	mocks: Array<string>
}

export type PreviewSnapshot = {
	prNumber: number | null
	prUrl: string | null
	isDraft: boolean
	headSha: string | null
	previewUrl: string | null
	workerName: string | null
	runtimeWorkerName: string | null
	runtimeUrl: string | null
	d1DatabaseName: string | null
	oauthKvTitle: string | null
	mocks: Array<string>
	expectedSha: string | null
	workflowUrl: string | null
	workflowStatus: string | null
	workflowConclusion: string | null
	workflowHeadSha: string | null
	deploymentSha: string | null
}

export type SmokeCheck = {
	name: string
	ok: boolean
	detail: string
}

export type SmokeReport = {
	ok: boolean
	checks: Array<SmokeCheck>
	sessionEmail: string | null
	commitSha: string | null
	runtimeCommitSha: string | null
	cookieHeader: string | null
}

export type PreviewSession = {
	cookieHeader: string | null
	origin: string | null
	cookieFile: string | null
}

export type PreviewManualTestResult = {
	ok: boolean
	message: string
	options: PreviewManualTestOptions
	snapshot: PreviewSnapshot
	smoke: SmokeReport | null
	session: PreviewSession
	login: {
		email: string
		password: string
		username: string
		admin: false
	}
	briefing: string
}

export type GhResult = {
	status: number
	stdout: string
	stderr: string
}

export type PreviewManualTestDeps = {
	execGh: (args: ReadonlyArray<string>) => Promise<GhResult>
	fetch: typeof fetch
	sleep: (ms: number) => Promise<void>
	now: () => number
	log: (message: string) => void
	error: (message: string) => void
	print: (message: string) => void
	writeFile: (path: string, contents: string) => Promise<void>
}

async function writeFileCreatingParents(path: string, contents: string) {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, contents)
}

const defaultDeps: PreviewManualTestDeps = {
	execGh,
	fetch,
	sleep,
	now: () => Date.now(),
	log: (message) => {
		console.error(message)
	},
	error: (message) => {
		console.error(message)
	},
	print: (message) => {
		console.log(message)
	},
	writeFile: writeFileCreatingParents,
}

export function previewSeedUsername() {
	return usernameFromEmail(previewSeedEmail)
}

export function parseArgs(argv: Array<string>): PreviewManualTestOptions {
	const options: PreviewManualTestOptions = {
		prNumber: null,
		previewUrl: null,
		expectedSha: null,
		wait: true,
		timeoutMs: defaultWaitTimeoutMs,
		pollIntervalMs: defaultPollIntervalMs,
		skipLogin: false,
		checkPaths: [],
		sessionRequests: [],
		cookieFile: null,
		json: false,
		help: false,
	}

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue
		switch (arg) {
			case '--help':
			case '-h': {
				options.help = true
				break
			}
			case '--json': {
				options.json = true
				break
			}
			case '--no-wait': {
				options.wait = false
				break
			}
			case '--skip-login': {
				options.skipLogin = true
				break
			}
			case '--pr': {
				options.prNumber = parsePositiveInt(argv[index + 1], '--pr')
				index += 1
				break
			}
			case '--url': {
				options.previewUrl = requireValue(argv[index + 1], '--url')
				index += 1
				break
			}
			case '--sha': {
				options.expectedSha = requireValue(argv[index + 1], '--sha')
				index += 1
				break
			}
			case '--timeout-ms': {
				options.timeoutMs = parsePositiveInt(argv[index + 1], '--timeout-ms')
				index += 1
				break
			}
			case '--poll-ms': {
				options.pollIntervalMs = parsePositiveInt(argv[index + 1], '--poll-ms')
				index += 1
				break
			}
			case '--check': {
				options.checkPaths.push(requireValue(argv[index + 1], '--check'))
				index += 1
				break
			}
			case '--request': {
				options.sessionRequests.push(
					parseSessionRequest(requireValue(argv[index + 1], '--request')),
				)
				index += 1
				break
			}
			case '--cookie-file': {
				options.cookieFile = requireValue(argv[index + 1], '--cookie-file')
				index += 1
				break
			}
			default: {
				if (arg.startsWith('-')) {
					throw new PreviewManualTestError(
						`Unknown flag: ${arg}\n\n${usageLines.join('\n')}`,
					)
				}
				throw new PreviewManualTestError(
					`Unexpected argument: ${arg}\n\n${usageLines.join('\n')}`,
				)
			}
		}
	}

	if (options.skipLogin) {
		if (options.checkPaths.length > 0) {
			throw new PreviewManualTestError(
				'--check requires a session cookie; omit --skip-login.',
			)
		}
		if (options.sessionRequests.length > 0) {
			throw new PreviewManualTestError(
				'--request requires a session cookie; omit --skip-login.',
			)
		}
		if (options.cookieFile) {
			throw new PreviewManualTestError(
				'--cookie-file requires a session cookie; omit --skip-login.',
			)
		}
	}

	return options
}

const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function isHttpMethod(value: string): value is HttpMethod {
	return (httpMethods as ReadonlyArray<string>).includes(value)
}

export function parseSessionRequest(spec: string): SessionRequestSpec {
	const trimmed = spec.trim()
	const match =
		/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s+(\d{3}))?(?:\s+([\s\S]+))?$/i.exec(
			trimmed,
		)
	if (!match?.[1] || !match[2]) {
		throw new PreviewManualTestError(
			`Invalid --request spec: ${spec}\nExpected: METHOD /path [status] [json-body]`,
		)
	}
	const methodName = match[1].toUpperCase()
	if (!isHttpMethod(methodName)) {
		throw new PreviewManualTestError(`Unsupported HTTP method: ${methodName}`)
	}
	const path = match[2]
	if (!path.startsWith('/')) {
		throw new PreviewManualTestError(
			`--request path must start with /: ${path}`,
		)
	}
	const expectedStatus = match[3] ? Number.parseInt(match[3], 10) : null
	const rawBody = match[4]?.trim() ?? ''
	let body: unknown | null = null
	if (rawBody.length > 0) {
		if (methodName === 'GET') {
			throw new PreviewManualTestError(
				'GET --request cannot include a JSON body.',
			)
		}
		try {
			body = JSON.parse(rawBody) as unknown
		} catch {
			throw new PreviewManualTestError(
				`--request body is not valid JSON: ${rawBody}`,
			)
		}
	}
	return {
		method: methodName,
		path,
		expectedStatus,
		body,
	}
}

export function sessionRequestName(spec: SessionRequestSpec) {
	const status =
		spec.expectedStatus === null ? '2xx' : String(spec.expectedStatus)
	return `${spec.method} ${spec.path} (${status})`
}

export function evaluateSessionRequestStatus(
	actualStatus: number,
	expectedStatus: number | null,
) {
	if (expectedStatus === null) {
		return actualStatus >= 200 && actualStatus < 300
	}
	return actualStatus === expectedStatus
}

export function parsePreviewComment(body: string): ParsedPreviewComment | null {
	if (!body.includes(previewCommentMarker)) return null

	const previewUrl = matchFirst(
		body,
		/🔎 Preview deployed:\s*(https?:\/\/\S+)/i,
	)
	const workerName = matchFirst(body, /Worker:\s*`([^`]+)`/)
	const runtimeLine = body.match(
		/Runtime worker:\s*`([^`]+)`\s*(?:\((https?:\/\/[^)\s]+)\))?/i,
	)
	const d1DatabaseName = matchFirst(body, /D1:\s*`([^`]+)`/)
	const oauthKvTitle = matchFirst(body, /KV:\s*`([^`]+)`/)
	const mocks: Array<string> = []
	const mocksSection = body.split(/\nMocks:\s*\n/i)[1]
	if (mocksSection) {
		for (const line of mocksSection.split('\n')) {
			const trimmed = line.trim()
			if (trimmed.startsWith('- ')) mocks.push(trimmed.slice(2).trim())
		}
	}

	return {
		previewUrl,
		workerName,
		runtimeWorkerName: runtimeLine?.[1] ?? null,
		runtimeUrl: runtimeLine?.[2] ?? null,
		d1DatabaseName,
		oauthKvTitle,
		mocks,
	}
}

export function workerNameFromPreviewUrl(previewUrl: string): string | null {
	try {
		const hostname = new URL(previewUrl).hostname
		if (!hostname.endsWith('.workers.dev')) return null
		const label = hostname.split('.')[0]
		return label || null
	} catch {
		return null
	}
}

export function deriveSiblingWorkerUrl(
	previewUrl: string,
	workerName: string,
	siblingWorkerName: string,
): string | null {
	try {
		const url = new URL(previewUrl)
		const labels = url.hostname.split('.')
		if (labels[0] !== workerName) return null
		labels[0] = siblingWorkerName
		url.hostname = labels.join('.')
		url.pathname = '/'
		url.search = ''
		url.hash = ''
		return url.origin
	} catch {
		return null
	}
}

export function cookieHeaderFromSetCookie(
	setCookieValues: ReadonlyArray<string>,
): string {
	return setCookieValues
		.map((value) => value.split(';')[0]?.trim() ?? '')
		.filter(Boolean)
		.join('; ')
}

export function displayTitleMentionsPr(
	displayTitle: string | undefined,
	prNumber: number,
) {
	if (!displayTitle) return false
	return new RegExp(`(?:^|\\D)#${prNumber}(?:\\D|$)`).test(displayTitle)
}

export function flattenGhJsonPages(parsed: unknown): Array<unknown> {
	if (!Array.isArray(parsed)) return []
	if (parsed.length > 0 && Array.isArray(parsed[0])) {
		return parsed.flat()
	}
	return parsed
}

export function commitShaMatchesExpected(
	commitSha: string | null,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string> = [],
) {
	if (!expectedSha) return true
	if (!commitSha) return false
	return commitSha === expectedSha || commitParents.includes(expectedSha)
}

export function evaluateAppHealth(
	body: unknown,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string> = [],
): { ok: boolean; commitSha: string | null; detail: string } {
	if (!body || typeof body !== 'object') {
		return {
			ok: false,
			commitSha: null,
			detail: 'health response was not JSON',
		}
	}
	const record = body as Record<string, unknown>
	const commitSha =
		typeof record.commitSha === 'string' && record.commitSha.length > 0
			? record.commitSha
			: null
	if (record.ok !== true) {
		return {
			ok: false,
			commitSha,
			detail: `health ok is not true (${JSON.stringify(body)})`,
		}
	}
	if (!commitShaMatchesExpected(commitSha, expectedSha, commitParents)) {
		return {
			ok: false,
			commitSha,
			detail: `health commitSha ${commitSha ?? '(missing)'} does not match expected ${expectedSha}`,
		}
	}
	return {
		ok: true,
		commitSha,
		detail: healthMatchDetail(commitSha, expectedSha, commitParents),
	}
}

export function evaluateRuntimeHealth(
	body: unknown,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string> = [],
): { ok: boolean; commitSha: string | null; detail: string } {
	if (!body || typeof body !== 'object') {
		return {
			ok: false,
			commitSha: null,
			detail: 'runtime health response was not JSON',
		}
	}
	const record = body as Record<string, unknown>
	const commitSha =
		typeof record.commitSha === 'string' && record.commitSha.length > 0
			? record.commitSha
			: null
	if (record.status !== 'ok') {
		return {
			ok: false,
			commitSha,
			detail: `runtime status is not ok (${JSON.stringify(body)})`,
		}
	}
	if (record.cookieSecretConfigured !== true) {
		return {
			ok: false,
			commitSha,
			detail: 'runtime cookieSecretConfigured is not true',
		}
	}
	if (!commitShaMatchesExpected(commitSha, expectedSha, commitParents)) {
		return {
			ok: false,
			commitSha,
			detail: `runtime commitSha ${commitSha ?? '(missing)'} does not match expected ${expectedSha}`,
		}
	}
	return {
		ok: true,
		commitSha,
		detail: healthMatchDetail(commitSha, expectedSha, commitParents),
	}
}

function healthMatchDetail(
	commitSha: string | null,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string>,
) {
	if (!commitSha) return 'ok'
	if (
		expectedSha &&
		commitSha !== expectedSha &&
		commitParents.includes(expectedSha)
	) {
		return `ok, commitSha ${commitSha} (merge of ${expectedSha})`
	}
	return `ok, commitSha ${commitSha}`
}

export function formatBriefing(result: PreviewManualTestResult): string {
	const lines = [
		result.ok
			? 'Preview is ready for manual testing.'
			: `Preview is not ready: ${result.message}`,
		'',
		result.snapshot.previewUrl
			? `URL: ${result.snapshot.previewUrl}`
			: 'URL: (not found)',
		result.snapshot.prUrl ? `PR: ${result.snapshot.prUrl}` : null,
		result.snapshot.workerName
			? `Worker: \`${result.snapshot.workerName}\``
			: null,
		result.snapshot.runtimeUrl
			? `Runtime: ${result.snapshot.runtimeUrl}${result.snapshot.runtimeWorkerName ? ` (\`${result.snapshot.runtimeWorkerName}\`)` : ''}`
			: null,
		result.smoke?.commitSha
			? `Deployed commit: ${result.smoke.commitSha}`
			: result.snapshot.expectedSha
				? `Expected commit: ${result.snapshot.expectedSha}`
				: result.snapshot.previewUrl
					? 'Warning: no expected /health commitSha (no GitHub preview deployment SHA and no --sha). Any healthy worker is accepted.'
					: null,
		result.snapshot.headSha &&
		result.smoke?.commitSha &&
		result.snapshot.headSha !== result.smoke.commitSha
			? `PR head SHA: ${result.snapshot.headSha} (preview deploys GitHub's merge commit, so /health commitSha can differ from the branch tip)`
			: result.snapshot.headSha
				? `PR head SHA: ${result.snapshot.headSha}`
				: null,
		result.snapshot.d1DatabaseName
			? `D1: \`${result.snapshot.d1DatabaseName}\``
			: null,
		result.snapshot.oauthKvTitle
			? `KV: \`${result.snapshot.oauthKvTitle}\``
			: null,
		'',
		`Login (preview seed, non-admin): ${result.login.email} / ${result.login.password}`,
		`Username: ${result.login.username}`,
		'`/admin` is expected to 403 — preview does not seed an admin account.',
		result.session.cookieHeader
			? 'Session cookie: `--json` field `session.cookieHeader`, or `--cookie-file`.'
			: null,
	].filter((line): line is string => line !== null)

	if (result.snapshot.mocks.length > 0) {
		lines.push('', 'Mocks:')
		for (const mock of result.snapshot.mocks) {
			lines.push(`- ${mock}`)
		}
	}

	if (result.smoke) {
		lines.push('', 'Smoke:')
		for (const check of result.smoke.checks) {
			lines.push(`- ${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`)
		}
	}

	lines.push(
		'',
		'Logged-in testing (required for medium/high risk):',
		'The seed account starts empty except the user row. Create the data this',
		'PR needs through the same JSON APIs the UI uses, then assert them:',
		'  npm run preview:manual-test -- --request \'POST /account/values.json {"action":"save","name":"preview-locale","value":"en-US"}\' --request \'GET /account/values.json\'',
		'Follow-up curl with the session cookie:',
		`  curl -sS -H "Cookie: $COOKIE" -H 'Accept: application/json' ${result.session.origin ?? '<preview-url>'}/account/values.json`,
		'Stay on the preview origin. `/mcp` is 401 without OAuth by design.',
		'',
		'UI pass after data exists: open the preview URL (computerUse on Cloud',
		'Agents), sign in with the credentials above, and exercise the changed flows.',
		'Record what you saw in the PR. This does not replace `npm run validate`.',
		'',
		'Docs: docs/contributing/preview-manual-testing.md',
	)

	if (result.snapshot.workflowUrl) {
		lines.push(`Preview workflow: ${result.snapshot.workflowUrl}`)
	}

	return lines.join('\n')
}

export async function runPreviewManualTest(
	argv: Array<string>,
	deps: PreviewManualTestDeps = defaultDeps,
): Promise<{ exitCode: number; result: PreviewManualTestResult | null }> {
	let options: PreviewManualTestOptions
	try {
		options = parseArgs(argv)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		deps.error(message)
		return { exitCode: 1, result: null }
	}

	if (options.help) {
		deps.print(usageLines.join('\n'))
		return { exitCode: 0, result: null }
	}

	try {
		const snapshot = await resolveAndWait(options, deps)
		const smoke =
			snapshot.previewUrl === null
				? null
				: await runSmokeChecks(snapshot, options, deps)
		const result = buildResult(options, snapshot, smoke)
		if (options.json) {
			deps.print(JSON.stringify(result, null, 2))
		} else {
			deps.print(result.briefing)
		}
		if (!result.ok) deps.error(result.message)
		return { exitCode: result.ok ? 0 : 1, result }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		deps.error(message)
		return { exitCode: 1, result: null }
	}
}

export class PreviewManualTestError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PreviewManualTestError'
	}
}

function requireValue(value: string | undefined, flag: string) {
	if (!value || value.startsWith('-')) {
		throw new PreviewManualTestError(`Missing value for ${flag}`)
	}
	return value
}

function parsePositiveInt(value: string | undefined, flag: string) {
	const parsed = Number.parseInt(requireValue(value, flag), 10)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new PreviewManualTestError(`${flag} must be a positive integer`)
	}
	return parsed
}

function matchFirst(body: string, pattern: RegExp) {
	return body.match(pattern)?.[1] ?? null
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function execGh(args: ReadonlyArray<string>): Promise<GhResult> {
	try {
		const result = await execFileAsync('gh', [...args], {
			encoding: 'utf8',
			maxBuffer: 10 * 1024 * 1024,
		})
		return { status: 0, stdout: result.stdout, stderr: result.stderr }
	} catch (error) {
		const failure = error as {
			status?: number | null
			stdout?: string
			stderr?: string
			message?: string
		}
		return {
			status: failure.status ?? 1,
			stdout: failure.stdout ?? '',
			stderr: failure.stderr ?? failure.message ?? '',
		}
	}
}

async function ghJson<T>(
	deps: PreviewManualTestDeps,
	args: ReadonlyArray<string>,
): Promise<T> {
	const result = await deps.execGh(args)
	if (result.status !== 0) {
		throw new PreviewManualTestError(
			`gh ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`,
		)
	}
	try {
		return JSON.parse(result.stdout) as T
	} catch {
		throw new PreviewManualTestError(
			`gh ${args.join(' ')} returned invalid JSON`,
		)
	}
}

type PrView = {
	number: number
	url: string
	isDraft: boolean
	headRefOid: string
}

type IssueComment = { body?: string }

type WorkflowRun = {
	databaseId: number
	status: string
	conclusion: string | null
	headSha: string
	event: string
	url: string
	displayTitle: string
}

type Deployment = {
	id: number
	sha: string
	environment: string
}

async function resolveAndWait(
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<PreviewSnapshot> {
	const deadline = deps.now() + options.timeoutMs
	let snapshot = await loadSnapshot(options, deps)

	if (snapshot.isDraft && !options.previewUrl) {
		throw new PreviewManualTestError(
			`PR #${snapshot.prNumber} is a draft. Preview deploys skip drafts. Mark the PR ready for review, wait for the 🔎 Preview workflow, then re-run.`,
		)
	}

	if (!options.wait) {
		if (!snapshot.previewUrl) {
			throw new PreviewManualTestError(notReadyMessage(snapshot))
		}
		return snapshot
	}

	while (true) {
		if (
			snapshot.workflowHeadSha === snapshot.headSha &&
			snapshot.workflowConclusion &&
			isFailedConclusion(snapshot.workflowConclusion)
		) {
			throw new PreviewManualTestError(
				`Preview workflow ${snapshot.workflowConclusion}${snapshot.workflowUrl ? `: ${snapshot.workflowUrl}` : ''}`,
			)
		}
		const healthReady =
			Boolean(snapshot.previewUrl) && (await previewHealthReady(snapshot, deps))
		const workflowReady = previewWorkflowReady(snapshot, options)
		if (healthReady && workflowReady) {
			warnIfMissingExpectedSha(snapshot, deps)
			return snapshot
		}
		if (deps.now() >= deadline) {
			throw new PreviewManualTestError(
				`Timed out after ${options.timeoutMs}ms. ${notReadyMessage(snapshot)}`,
			)
		}
		deps.log(waitStatusMessage(snapshot, healthReady, workflowReady))
		await deps.sleep(options.pollIntervalMs)
		snapshot = await loadSnapshot(options, deps)
	}
}

function skipPreviewWorkflowGate(options: PreviewManualTestOptions) {
	return Boolean(options.previewUrl) && options.prNumber === null
}

function previewWorkflowReady(
	snapshot: PreviewSnapshot,
	options: PreviewManualTestOptions,
) {
	if (skipPreviewWorkflowGate(options)) return true
	if (!snapshot.headSha || snapshot.workflowHeadSha !== snapshot.headSha) {
		return false
	}
	return (
		snapshot.workflowStatus === 'completed' &&
		snapshot.workflowConclusion === 'success'
	)
}

function warnIfMissingExpectedSha(
	snapshot: PreviewSnapshot,
	deps: PreviewManualTestDeps,
) {
	if (snapshot.previewUrl && !snapshot.expectedSha) {
		deps.log(
			'Warning: no expected /health commitSha (no GitHub preview deployment SHA and no --sha). Any healthy worker is accepted.',
		)
	}
}

async function loadSnapshot(
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<PreviewSnapshot> {
	if (options.previewUrl && options.prNumber === null) {
		const workerName = workerNameFromPreviewUrl(options.previewUrl)
		const runtimeWorkerName = workerName ? `${workerName}-runtime` : null
		return {
			prNumber: null,
			prUrl: null,
			isDraft: false,
			headSha: null,
			previewUrl: options.previewUrl,
			workerName,
			runtimeWorkerName,
			runtimeUrl:
				workerName && runtimeWorkerName
					? deriveSiblingWorkerUrl(
							options.previewUrl,
							workerName,
							runtimeWorkerName,
						)
					: null,
			d1DatabaseName: null,
			oauthKvTitle: null,
			mocks: [],
			expectedSha: options.expectedSha,
			workflowUrl: null,
			workflowStatus: null,
			workflowConclusion: null,
			workflowHeadSha: null,
			deploymentSha: null,
		}
	}

	const pr = await loadPullRequest(options, deps)
	const comment = await loadPreviewComment(pr.number, deps)
	const parsed = comment ? parsePreviewComment(comment) : null
	const workflow = await loadPreviewWorkflow(pr, deps)
	const deploymentSha = await loadDeploymentSha(pr.number, deps)
	const previewUrl = options.previewUrl ?? parsed?.previewUrl ?? null
	const workerName =
		parsed?.workerName ??
		(previewUrl ? workerNameFromPreviewUrl(previewUrl) : null)
	const runtimeWorkerName =
		parsed?.runtimeWorkerName ?? (workerName ? `${workerName}-runtime` : null)
	const runtimeUrl =
		parsed?.runtimeUrl ??
		(previewUrl && workerName && runtimeWorkerName
			? deriveSiblingWorkerUrl(previewUrl, workerName, runtimeWorkerName)
			: null)

	return {
		prNumber: pr.number,
		prUrl: pr.url,
		isDraft: pr.isDraft,
		headSha: pr.headRefOid,
		previewUrl,
		workerName,
		runtimeWorkerName,
		runtimeUrl,
		d1DatabaseName: parsed?.d1DatabaseName ?? null,
		oauthKvTitle: parsed?.oauthKvTitle ?? null,
		mocks: parsed?.mocks ?? [],
		expectedSha: options.expectedSha ?? deploymentSha ?? pr.headRefOid,
		workflowUrl: workflow?.url ?? null,
		workflowStatus: workflow?.status ?? null,
		workflowConclusion: workflow?.conclusion ?? null,
		workflowHeadSha: workflow?.headSha ?? null,
		deploymentSha,
	}
}

async function loadPullRequest(
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<PrView> {
	const args = ['pr', 'view', '--json', 'number,url,isDraft,headRefOid']
	if (options.prNumber !== null) {
		args.splice(2, 0, String(options.prNumber))
	}
	return ghJson<PrView>(deps, args)
}

async function loadPreviewComment(
	prNumber: number,
	deps: PreviewManualTestDeps,
): Promise<string | null> {
	const repo = await ghJson<{ nameWithOwner: string }>(deps, [
		'repo',
		'view',
		'--json',
		'nameWithOwner',
	])
	const comments = flattenGhJsonPages(
		await ghJson<unknown>(deps, [
			'api',
			'--paginate',
			'--slurp',
			`repos/${repo.nameWithOwner}/issues/${prNumber}/comments?per_page=100`,
		]),
	) as Array<IssueComment>
	const match = comments.find((comment) =>
		comment.body?.includes(previewCommentMarker),
	)
	return match?.body ?? null
}

async function loadPreviewWorkflow(
	pr: PrView,
	deps: PreviewManualTestDeps,
): Promise<WorkflowRun | null> {
	const runs = await ghJson<Array<WorkflowRun>>(deps, [
		'run',
		'list',
		'--workflow',
		'preview.yml',
		'--commit',
		pr.headRefOid,
		'--json',
		'databaseId,status,conclusion,headSha,event,url,displayTitle',
		'--limit',
		'10',
	])
	return (
		runs.find((run) => run.headSha === pr.headRefOid) ??
		runs.find((run) => displayTitleMentionsPr(run.displayTitle, pr.number)) ??
		null
	)
}

async function loadDeploymentSha(
	prNumber: number,
	deps: PreviewManualTestDeps,
): Promise<string | null> {
	try {
		const repo = await ghJson<{ nameWithOwner: string }>(deps, [
			'repo',
			'view',
			'--json',
			'nameWithOwner',
		])
		const deployments = await ghJson<Array<Deployment>>(deps, [
			'api',
			`repos/${repo.nameWithOwner}/deployments?environment=preview-${prNumber}&per_page=5`,
		])
		return deployments[0]?.sha ?? null
	} catch {
		return null
	}
}

async function previewHealthReady(
	snapshot: PreviewSnapshot,
	deps: PreviewManualTestDeps,
): Promise<boolean> {
	if (!snapshot.previewUrl) return false
	try {
		const response = await fetchJson(
			deps,
			`${snapshot.previewUrl.replace(/\/$/, '')}/health`,
		)
		const healthEval = await evaluateFetchedHealth(
			deps,
			evaluateAppHealth,
			response.body,
			snapshot.expectedSha,
		)
		return healthEval.ok
	} catch {
		return false
	}
}

async function evaluateFetchedHealth(
	deps: PreviewManualTestDeps,
	evaluate: (
		body: unknown,
		expectedSha: string | null,
		commitParents?: ReadonlyArray<string>,
	) => { ok: boolean; commitSha: string | null; detail: string },
	body: unknown,
	expectedSha: string | null,
) {
	const first = evaluate(body, expectedSha)
	if (first.ok || !first.commitSha || !expectedSha) return first
	const parents = await loadCommitParents(deps, first.commitSha)
	if (!parents) return first
	return evaluate(body, expectedSha, parents)
}

async function loadCommitParents(
	deps: PreviewManualTestDeps,
	sha: string,
): Promise<Array<string> | null> {
	try {
		const repo = await ghJson<{ nameWithOwner: string }>(deps, [
			'repo',
			'view',
			'--json',
			'nameWithOwner',
		])
		const commit = await ghJson<{ parents?: Array<{ sha?: string }> }>(deps, [
			'api',
			`repos/${repo.nameWithOwner}/commits/${sha}`,
		])
		return (commit.parents ?? [])
			.map((parent) => parent.sha)
			.filter((parentSha): parentSha is string => Boolean(parentSha))
	} catch {
		return null
	}
}

async function runSmokeChecks(
	snapshot: PreviewSnapshot,
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<SmokeReport> {
	if (!snapshot.previewUrl) {
		return {
			ok: false,
			checks: [
				{
					name: 'preview-url',
					ok: false,
					detail: 'no preview URL',
				},
			],
			sessionEmail: null,
			commitSha: null,
			runtimeCommitSha: null,
			cookieHeader: null,
		}
	}

	const origin = snapshot.previewUrl.replace(/\/$/, '')
	const checks: Array<SmokeCheck> = []
	let sessionEmail: string | null = null
	let commitSha: string | null = null
	let runtimeCommitSha: string | null = null
	let cookieHeader = ''

	const health = await fetchJson(deps, `${origin}/health`)
	if (health.error) {
		checks.push({
			name: 'GET /health',
			ok: false,
			detail: health.error,
		})
	} else {
		const healthEval = await evaluateFetchedHealth(
			deps,
			evaluateAppHealth,
			health.body,
			snapshot.expectedSha,
		)
		commitSha = healthEval.commitSha
		checks.push({
			name: 'GET /health',
			ok: health.status === 200 && healthEval.ok,
			detail:
				health.status === 200
					? healthEval.detail
					: `HTTP ${health.status}: ${healthEval.detail}`,
		})
	}

	const loginPage = await fetchText(deps, `${origin}/login`)
	if (loginPage.error) {
		checks.push({
			name: 'GET /login',
			ok: false,
			detail: loginPage.error,
		})
	} else {
		const loginPageOk =
			loginPage.status === 200 &&
			loginPage.body.includes('Welcome back') &&
			/email/i.test(loginPage.body) &&
			/password/i.test(loginPage.body)
		checks.push({
			name: 'GET /login',
			ok: loginPageOk,
			detail: loginPageOk
				? 'login form rendered'
				: `HTTP ${loginPage.status}; expected "Welcome back" plus email/password fields`,
		})
	}

	const mcp = await fetchText(deps, `${origin}/mcp`, {
		headers: { Accept: 'application/json, text/event-stream' },
	})
	if (mcp.error) {
		checks.push({
			name: 'GET /mcp',
			ok: false,
			detail: mcp.error,
		})
	} else {
		checks.push({
			name: 'GET /mcp',
			ok: mcp.status === 401,
			detail:
				mcp.status === 401
					? '401 without OAuth, as expected'
					: `expected 401, got HTTP ${mcp.status}`,
		})
	}

	if (snapshot.runtimeUrl) {
		const runtimeHealth = await fetchJson(
			deps,
			`${snapshot.runtimeUrl.replace(/\/$/, '')}${runtimeWorkerHealthPath}`,
		)
		if (runtimeHealth.error) {
			checks.push({
				name: `GET ${runtimeWorkerHealthPath}`,
				ok: false,
				detail: runtimeHealth.error,
			})
		} else {
			const runtimeEval = await evaluateFetchedHealth(
				deps,
				evaluateRuntimeHealth,
				runtimeHealth.body,
				snapshot.expectedSha,
			)
			runtimeCommitSha = runtimeEval.commitSha
			checks.push({
				name: `GET ${runtimeWorkerHealthPath}`,
				ok: runtimeHealth.status === 200 && runtimeEval.ok,
				detail:
					runtimeHealth.status === 200
						? runtimeEval.detail
						: `HTTP ${runtimeHealth.status}: ${runtimeEval.detail}`,
			})
		}
	}

	if (!options.skipLogin) {
		const auth = await fetchJson(deps, `${origin}/auth`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: previewSeedEmail,
				password: previewSeedPassword,
				mode: 'login',
			}),
		})
		if (auth.error) {
			checks.push({
				name: 'POST /auth',
				ok: false,
				detail: auth.error,
			})
		} else {
			cookieHeader = cookieHeaderFromSetCookie(auth.setCookie)
			const authOk =
				auth.status === 200 &&
				Boolean(cookieHeader) &&
				(auth.body as { ok?: unknown } | null)?.ok !== false
			checks.push({
				name: 'POST /auth',
				ok: authOk,
				detail: authOk
					? `signed in as ${previewSeedEmail}`
					: `HTTP ${auth.status} ${JSON.stringify(auth.body)}; Set-Cookie ${auth.setCookie.length > 0 ? 'present' : 'missing'}`,
			})
		}

		if (cookieHeader) {
			const session = await fetchJson(deps, `${origin}/session`, {
				headers: { Cookie: cookieHeader, Accept: 'application/json' },
			})
			if (session.error) {
				checks.push({
					name: 'GET /session',
					ok: false,
					detail: session.error,
				})
			} else {
				const sessionRecord =
					session.body && typeof session.body === 'object'
						? (session.body as {
								ok?: unknown
								session?: { email?: unknown }
							})
						: null
				sessionEmail =
					typeof sessionRecord?.session?.email === 'string'
						? sessionRecord.session.email
						: null
				const sessionOk =
					session.status === 200 &&
					sessionRecord?.ok === true &&
					sessionEmail?.toLowerCase() === previewSeedEmail
				checks.push({
					name: 'GET /session',
					ok: sessionOk,
					detail: sessionOk
						? `session email ${sessionEmail}`
						: `HTTP ${session.status} ${JSON.stringify(session.body)}`,
				})
			}

			const account = await fetchText(deps, `${origin}/account`, {
				headers: { Cookie: cookieHeader },
				redirect: 'manual',
			})
			if (account.error) {
				checks.push({
					name: 'GET /account',
					ok: false,
					detail: account.error,
				})
			} else {
				const accountOk = account.status === 200
				checks.push({
					name: 'GET /account',
					ok: accountOk,
					detail: accountOk
						? 'authenticated account page'
						: `expected HTTP 200, got ${account.status}`,
				})
			}

			if (options.cookieFile) {
				try {
					await deps.writeFile(options.cookieFile, `${cookieHeader}\n`)
					checks.push({
						name: 'cookie-file',
						ok: true,
						detail: options.cookieFile,
					})
				} catch (error) {
					checks.push({
						name: 'cookie-file',
						ok: false,
						detail:
							error instanceof Error
								? error.message
								: `failed to write ${options.cookieFile}`,
					})
				}
			}

			for (const spec of options.sessionRequests) {
				const requestCheck = await runAuthenticatedSessionRequest(
					deps,
					origin,
					cookieHeader,
					spec,
				)
				checks.push(requestCheck)
			}

			for (const path of options.checkPaths) {
				const normalized = path.startsWith('/') ? path : `/${path}`
				const extra = await fetchText(deps, `${origin}${normalized}`, {
					headers: { Cookie: cookieHeader },
					redirect: 'manual',
				})
				checks.push({
					name: `GET ${normalized}`,
					ok: extra.error ? false : extra.status === 200,
					detail: extra.error
						? extra.error
						: extra.status === 200
							? '200'
							: `HTTP ${extra.status}`,
				})
			}
		}
	}

	return {
		ok: checks.every((check) => check.ok),
		checks,
		sessionEmail,
		commitSha,
		runtimeCommitSha,
		cookieHeader: cookieHeader || null,
	}
}

function buildResult(
	options: PreviewManualTestOptions,
	snapshot: PreviewSnapshot,
	smoke: SmokeReport | null,
): PreviewManualTestResult {
	const login = {
		email: previewSeedEmail,
		password: previewSeedPassword,
		username: previewSeedUsername(),
		admin: false as const,
	}
	let message = 'ready'
	let ok = true
	if (!snapshot.previewUrl) {
		ok = false
		message = notReadyMessage(snapshot)
	} else if (smoke && !smoke.ok) {
		ok = false
		message = 'preview smoke checks failed'
	}
	const result: PreviewManualTestResult = {
		ok,
		message,
		options,
		snapshot,
		smoke,
		session: {
			cookieHeader: smoke?.cookieHeader ?? null,
			origin: snapshot.previewUrl
				? snapshot.previewUrl.replace(/\/$/, '')
				: null,
			cookieFile: options.cookieFile,
		},
		login,
		briefing: '',
	}
	result.briefing = formatBriefing(result)
	return result
}

function notReadyMessage(snapshot: PreviewSnapshot) {
	if (snapshot.isDraft) {
		return 'PR is a draft, so no preview deploy ran.'
	}
	if (snapshot.workflowUrl && snapshot.workflowStatus) {
		return `No healthy preview URL yet (workflow ${snapshot.workflowStatus}${snapshot.workflowConclusion ? `/${snapshot.workflowConclusion}` : ''}: ${snapshot.workflowUrl}).`
	}
	return [
		'No preview URL found on the PR.',
		'Previews skip drafts and fork PRs. Push to a ready-for-review PR on this repo, wait for 🔎 Preview, then re-run.',
		snapshot.prUrl ? `PR: ${snapshot.prUrl}` : null,
	]
		.filter(Boolean)
		.join(' ')
}

function waitStatusMessage(
	snapshot: PreviewSnapshot,
	healthReady: boolean,
	workflowReady: boolean,
) {
	if (snapshot.previewUrl && healthReady && !workflowReady) {
		if (
			snapshot.headSha &&
			snapshot.workflowHeadSha &&
			snapshot.workflowHeadSha !== snapshot.headSha
		) {
			return `Waiting for a preview workflow run for ${snapshot.headSha}`
		}
		return `Waiting for preview workflow (${snapshot.workflowStatus ?? 'unknown'}${snapshot.workflowConclusion ? `/${snapshot.workflowConclusion}` : ''})${snapshot.workflowUrl ? `: ${snapshot.workflowUrl}` : ''}`
	}
	if (snapshot.previewUrl) {
		return snapshot.expectedSha
			? `Waiting for /health to serve ${snapshot.expectedSha} (exact or merge commit) at ${snapshot.previewUrl}`
			: `Waiting for a healthy /health at ${snapshot.previewUrl}`
	}
	if (snapshot.workflowUrl) {
		return `Waiting for preview workflow (${snapshot.workflowStatus ?? 'unknown'}): ${snapshot.workflowUrl}`
	}
	return 'Waiting for the 🔎 Preview workflow to comment the preview URL'
}

function isFailedConclusion(conclusion: string) {
	// `cancelled` is not terminal: preview.yml uses cancel-in-progress, so a
	// newer run for the same PR is expected to replace a cancelled one.
	return (
		conclusion === 'failure' ||
		conclusion === 'timed_out' ||
		conclusion === 'startup_failure'
	)
}

async function runAuthenticatedSessionRequest(
	deps: PreviewManualTestDeps,
	origin: string,
	cookieHeader: string,
	spec: SessionRequestSpec,
): Promise<SmokeCheck> {
	const headers: Record<string, string> = {
		Cookie: cookieHeader,
		Accept: spec.path.includes('.json') ? 'application/json' : '*/*',
	}
	const init: RequestInit = {
		method: spec.method,
		headers,
		redirect: 'manual',
	}
	if (spec.body !== null) {
		headers['Content-Type'] = 'application/json'
		init.body = JSON.stringify(spec.body)
	}
	const response = spec.path.includes('.json')
		? await fetchJson(deps, `${origin}${spec.path}`, init)
		: await fetchText(deps, `${origin}${spec.path}`, init)
	if (response.error) {
		return {
			name: sessionRequestName(spec),
			ok: false,
			detail: response.error,
		}
	}
	const ok = evaluateSessionRequestStatus(response.status, spec.expectedStatus)
	const expected =
		spec.expectedStatus === null ? '2xx' : String(spec.expectedStatus)
	return {
		name: sessionRequestName(spec),
		ok,
		detail: ok
			? `HTTP ${response.status} ${truncateDetail(response.body)}`
			: `expected ${expected}, got HTTP ${response.status} ${truncateDetail(response.body)}`,
	}
}

function truncateDetail(body: unknown, maxLength = 400) {
	const text =
		typeof body === 'string' ? body : body === null ? '' : JSON.stringify(body)
	const compact = text.replace(/\s+/g, ' ').trim()
	if (compact.length <= maxLength) return compact
	return `${compact.slice(0, maxLength)}…`
}

type FetchedJson = {
	status: number
	body: unknown
	setCookie: Array<string>
	error?: string
}

type FetchedText = {
	status: number
	body: string
	setCookie: Array<string>
	error?: string
}

async function fetchJson(
	deps: PreviewManualTestDeps,
	url: string,
	init: RequestInit = {},
): Promise<FetchedJson> {
	try {
		const response = await deps.fetch(url, {
			...init,
			signal: init.signal ?? AbortSignal.timeout(defaultRequestTimeoutMs),
		})
		const body = await response.json().catch(() => null)
		return {
			status: response.status,
			body,
			setCookie: readSetCookie(response),
		}
	} catch (error) {
		return {
			status: 0,
			body: null,
			setCookie: [],
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

async function fetchText(
	deps: PreviewManualTestDeps,
	url: string,
	init: RequestInit = {},
): Promise<FetchedText> {
	try {
		const response = await deps.fetch(url, {
			...init,
			signal: init.signal ?? AbortSignal.timeout(defaultRequestTimeoutMs),
		})
		return {
			status: response.status,
			body: await response.text().catch(() => ''),
			setCookie: readSetCookie(response),
		}
	} catch (error) {
		return {
			status: 0,
			body: '',
			setCookie: [],
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

function readSetCookie(response: Response) {
	if (typeof response.headers.getSetCookie === 'function') {
		return response.headers.getSetCookie()
	}
	const single = response.headers.get('set-cookie')
	return single ? [single] : []
}

if (isExecutedDirectly(import.meta.url)) {
	const { exitCode } = await runPreviewManualTest(process.argv.slice(2))
	process.exit(exitCode)
}
