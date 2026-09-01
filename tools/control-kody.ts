import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
	createDefaultEnsureDevDeps,
	ensureDev,
	formatAppRunning,
} from './ensure-dev.ts'
import {
	findHealthyWorkerOrigin,
	healthUrlForOrigin,
	isWorkerHealthOk,
	workerPortRange,
} from './dev-server.ts'
import { isExecutedDirectly, resolveNpmCommand } from './node-runtime.ts'
import {
	checkFeatureCatalog,
	featureCatalog,
	featuresDirRelativePath,
	findFeature,
	type Feature,
} from './control-kody/feature-catalog.ts'
import {
	cookieHeaderFromSetCookie,
	evaluateAppHealth,
	parseArgs as parsePreviewArgs,
	parseSessionRequest,
	previewSeedEmail,
	previewSeedPassword,
	runPreviewManualTest,
	type SessionRequestSpec,
} from './preview-manual-test.ts'

const execFileAsync = promisify(execFile)

export const localSeedEmail = 'jane@example.com'
export const localSeedPassword = 'ilikecode'
export const localAdminEmail = 'kody@example.com'

const usageLines = [
	'Usage: node tools/control-kody.ts <command> [options]',
	'',
	'Drive and verify the Kody app without throwaway scripts.',
	'',
	'Commands:',
	'  doctor     Check Node, Playwright browsers, hooks, and /health',
	'  dev        Start or reuse the local origin (npm run dev:ensure)',
	'  login      POST /auth and write a session cookie',
	'  request    Authenticated HTTP as the current session',
	'  preview    PR preview smoke (wraps preview:manual-test)',
	'  health     GET /health and optionally assert commitSha',
	'  map        List or print a Feature Map entry; --check for drift',
	'',
	'Common options:',
	'  --origin <url>       App origin (default: healthy local 3742-3751)',
	'  --json               Machine-readable stdout',
	'  --cookie-file <p>    Session Cookie header file',
	'  --help               Print this help',
	'',
	'Docs: docs/contributing/control-kody.md',
]

export type ControlKodyCommand =
	| 'doctor'
	| 'dev'
	| 'login'
	| 'request'
	| 'preview'
	| 'health'
	| 'map'
	| 'help'

export type ControlKodyOptions = {
	command: ControlKodyCommand
	origin: string | null
	json: boolean
	help: boolean
	cookieFile: string
	email: string | null
	password: string | null
	skipLogin: boolean
	sha: string | null
	featureId: string | null
	check: boolean
	request: SessionRequestSpec | null
	body: string | null
	previewArgv: Array<string>
}

export class ControlKodyError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ControlKodyError'
	}
}

export function defaultCookieFile() {
	return path.join('.tmp', 'control-kody-cookie')
}

export function credentialsForOrigin(origin: string) {
	try {
		const host = new URL(origin).hostname
		if (host === 'localhost' || host === '127.0.0.1') {
			return {
				email: localSeedEmail,
				password: localSeedPassword,
				kind: 'local' as const,
			}
		}
	} catch {
		// fall through to preview seed
	}
	return {
		email: previewSeedEmail,
		password: previewSeedPassword,
		kind: 'preview' as const,
	}
}

export function parseControlArgs(argv: Array<string>): ControlKodyOptions {
	const options: ControlKodyOptions = {
		command: 'help',
		origin: null,
		json: false,
		help: false,
		cookieFile: defaultCookieFile(),
		email: null,
		password: null,
		skipLogin: false,
		sha: null,
		featureId: null,
		check: false,
		request: null,
		body: null,
		previewArgv: [],
	}

	const [command, ...rest] = argv
	if (
		!command ||
		command === '--help' ||
		command === '-h' ||
		command === 'help'
	) {
		options.command = 'help'
		options.help = true
		return options
	}

	const commands: ReadonlyArray<ControlKodyCommand> = [
		'doctor',
		'dev',
		'login',
		'request',
		'preview',
		'health',
		'map',
		'help',
	]
	if (!commands.includes(command as ControlKodyCommand)) {
		throw new ControlKodyError(
			`Unknown command ${command}. Try: ${commands.join(', ')}`,
		)
	}
	options.command = command as ControlKodyCommand

	if (options.command === 'preview') {
		const separator = rest.indexOf('--')
		options.previewArgv = separator === -1 ? rest : rest.slice(separator + 1)
		if (separator === -1) {
			parseSharedFlags(rest, options)
		} else {
			parseSharedFlags(rest.slice(0, separator), options)
		}
		return options
	}

	if (options.command === 'request') {
		const positional: Array<string> = []
		parseSharedFlags(rest, options, positional)
		if (positional.length > 0) {
			const spec = [positional[0], positional[1], positional[2]]
				.filter((part): part is string => Boolean(part))
				.join(' ')
			const parsed = parseSessionRequest(spec)
			if (options.body) {
				parsed.body = JSON.parse(options.body)
			}
			options.request = parsed
		}
		return options
	}

	if (options.command === 'map') {
		const positional: Array<string> = []
		parseSharedFlags(rest, options, positional)
		options.featureId = positional[0] ?? null
		return options
	}

	parseSharedFlags(rest, options)
	return options
}

function parseSharedFlags(
	argv: Array<string>,
	options: ControlKodyOptions,
	positional: Array<string> = [],
) {
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
			case '--check': {
				options.check = true
				break
			}
			case '--skip-login': {
				options.skipLogin = true
				break
			}
			case '--origin': {
				options.origin = requireValue(argv[index + 1], '--origin')
				index += 1
				break
			}
			case '--cookie-file': {
				options.cookieFile = requireValue(argv[index + 1], '--cookie-file')
				index += 1
				break
			}
			case '--email': {
				options.email = requireValue(argv[index + 1], '--email')
				index += 1
				break
			}
			case '--password': {
				options.password = requireValue(argv[index + 1], '--password')
				index += 1
				break
			}
			case '--sha': {
				options.sha = requireValue(argv[index + 1], '--sha')
				index += 1
				break
			}
			case '--body': {
				options.body = requireValue(argv[index + 1], '--body')
				index += 1
				break
			}
			default: {
				if (arg.startsWith('-')) {
					throw new ControlKodyError(`Unknown flag ${arg}`)
				}
				positional.push(arg)
			}
		}
	}
}

function requireValue(value: string | undefined, flag: string) {
	if (!value || value.startsWith('-')) {
		throw new ControlKodyError(`${flag} requires a value`)
	}
	return value
}

export type DoctorCheck = {
	name: string
	ok: boolean
	detail: string
}

export type DoctorReport = {
	ok: boolean
	checks: Array<DoctorCheck>
}

export type DoctorDeps = {
	nodeVersion: string
	homeDir: string
	hooksPath: string | null
	playwrightMarkerExists: (homeDir: string) => boolean
	probeHealth: (origin: string) => Promise<boolean>
	ports: ReadonlyArray<number>
	origin: string | null
}

export function playwrightBrowsersInstalled(homeDir: string) {
	const root = path.join(homeDir, '.cache', 'ms-playwright')
	if (!existsSync(root)) return false
	try {
		const entries = readdirSync(root, { withFileTypes: true })
		return entries.some((entry) => {
			if (!entry.isDirectory()) return false
			return existsSync(path.join(root, entry.name, 'INSTALLATION_COMPLETE'))
		})
	} catch {
		return false
	}
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
	const checks: Array<DoctorCheck> = []
	const major = Number.parseInt(deps.nodeVersion.replace(/^v/, ''), 10)
	const nodeOk = Number.isFinite(major) && major >= 26
	checks.push({
		name: 'node',
		ok: nodeOk,
		detail: nodeOk
			? `Node ${deps.nodeVersion} (>=26)`
			: `Node ${deps.nodeVersion} is below 26. Prepend nvm's Node 26 bin to PATH. See docs/contributing/cloud-agents.md.`,
	})

	const playwrightOk = deps.playwrightMarkerExists(deps.homeDir)
	checks.push({
		name: 'playwright',
		ok: playwrightOk,
		detail: playwrightOk
			? 'Playwright INSTALLATION_COMPLETE marker present'
			: 'Playwright browsers missing. Do not run playwright install on this VM; unzip per docs/contributing/cloud-agents.md.',
	})

	const hooksOk = Boolean(deps.hooksPath && deps.hooksPath.length > 0)
	checks.push({
		name: 'hooks',
		ok: hooksOk,
		detail: hooksOk
			? `core.hooksPath=${deps.hooksPath}`
			: 'git core.hooksPath is empty. Run npm run hooks:ensure.',
	})

	const origin =
		deps.origin ??
		(await findHealthyWorkerOrigin(deps.ports, { probe: deps.probeHealth }))
	if (origin) {
		const healthy = await deps.probeHealth(origin)
		checks.push({
			name: 'health',
			ok: healthy,
			detail: healthy
				? `${origin}/health ok`
				: `${origin} accepted TCP but /health failed. Run control-kody dev.`,
		})
	} else {
		checks.push({
			name: 'health',
			ok: true,
			detail: 'no local origin yet; run control-kody dev when you need one',
		})
	}

	return { ok: checks.every((check) => check.ok), checks }
}

export async function resolveOrigin(options: {
	origin: string | null
	probeHealth?: (origin: string) => Promise<boolean>
}) {
	if (options.origin) return options.origin.replace(/\/$/, '')
	const probe =
		options.probeHealth ?? ((origin: string) => isWorkerHealthOk(origin))
	const found = await findHealthyWorkerOrigin(workerPortRange(), { probe })
	if (!found) {
		throw new ControlKodyError(
			'No healthy origin on 3742-3751. Run: node tools/control-kody.ts dev',
		)
	}
	return found
}

export type SessionResult = {
	ok: boolean
	origin: string
	email: string
	cookieHeader: string | null
	status: number | null
	detail: string
}

export async function loginToOrigin(input: {
	origin: string
	email: string
	password: string
	fetchImpl?: typeof fetch
}): Promise<SessionResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	const response = await fetchImpl(`${input.origin}/auth`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: input.email,
			password: input.password,
			mode: 'login',
		}),
	})
	const setCookie = response.headers.getSetCookie?.() ?? []
	const cookieHeader = cookieHeaderFromSetCookie(setCookie)
	let body: unknown = null
	try {
		body = await response.json()
	} catch {
		body = null
	}
	const ok =
		response.ok &&
		Boolean(cookieHeader) &&
		(body as { ok?: unknown } | null)?.ok !== false
	return {
		ok,
		origin: input.origin,
		email: input.email,
		cookieHeader: cookieHeader || null,
		status: response.status,
		detail: ok
			? `signed in as ${input.email}`
			: `HTTP ${response.status} ${JSON.stringify(body)}; cookie ${cookieHeader ? 'present' : 'missing'}`,
	}
}

export type RequestResult = {
	ok: boolean
	status: number
	path: string
	body: unknown
	detail: string
}

export async function requestAsSession(input: {
	origin: string
	spec: SessionRequestSpec
	cookieHeader: string | null
	fetchImpl?: typeof fetch
}): Promise<RequestResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	const headers: Record<string, string> = {
		Accept: 'application/json, text/html',
	}
	if (input.cookieHeader) headers.Cookie = input.cookieHeader
	if (input.spec.body !== null) headers['Content-Type'] = 'application/json'
	const response = await fetchImpl(`${input.origin}${input.spec.path}`, {
		method: input.spec.method,
		headers,
		body:
			input.spec.body === null ? undefined : JSON.stringify(input.spec.body),
	})
	const text = await response.text()
	let body: unknown = text
	try {
		body = JSON.parse(text) as unknown
	} catch {
		body = text
	}
	const expected = input.spec.expectedStatus
	const ok = expected === null ? response.ok : response.status === expected
	return {
		ok,
		status: response.status,
		path: input.spec.path,
		body,
		detail: ok
			? `HTTP ${response.status}`
			: `expected ${expected ?? '2xx'}, got HTTP ${response.status}`,
	}
}

export async function readHealth(input: {
	origin: string
	expectedSha: string | null
	fetchImpl?: typeof fetch
}) {
	const fetchImpl = input.fetchImpl ?? fetch
	const response = await fetchImpl(healthUrlForOrigin(input.origin))
	let body: unknown = null
	try {
		body = await response.json()
	} catch {
		body = null
	}
	const evaluated = evaluateAppHealth(body, input.expectedSha)
	return {
		ok: response.ok && evaluated.ok,
		status: response.status,
		origin: input.origin,
		commitSha: evaluated.commitSha,
		detail: response.ok
			? evaluated.detail
			: `HTTP ${response.status}: ${evaluated.detail}`,
	}
}

export function readCookieFile(cookieFile: string) {
	if (!existsSync(cookieFile)) return null
	const value = readFileSync(cookieFile, 'utf8').trim()
	return value.length > 0 ? value : null
}

export async function writeCookieFile(
	cookieFile: string,
	cookieHeader: string,
) {
	await mkdir(path.dirname(cookieFile), { recursive: true })
	await writeFile(cookieFile, `${cookieHeader}\n`)
}

export function formatFeatureMap(features: ReadonlyArray<Feature>) {
	return features
		.map(
			(feature) => `${feature.id}\t${feature.paths[0] ?? ''}\t${feature.title}`,
		)
		.join('\n')
}

export function repoRootFromHere(here = import.meta.dirname) {
	return path.resolve(here, '..')
}

export function defaultRoutesPath(root: string) {
	return path.join(root, 'packages/worker/universal/routes.ts')
}

export function defaultFeaturesDir(root: string) {
	return path.join(root, featuresDirRelativePath)
}

export function runMapCheck(input: {
	routeSource: string
	featuresDir: string
}) {
	const existingFiles = existsSync(input.featuresDir)
		? readdirSync(input.featuresDir).filter((name) => name.endsWith('.md'))
		: []
	return checkFeatureCatalog({
		routeSource: input.routeSource,
		existingFiles,
	})
}

export function defaultDoctorDeps(origin: string | null = null): DoctorDeps {
	return {
		nodeVersion: process.version,
		homeDir: homedir(),
		hooksPath: readGitHooksPath(),
		playwrightMarkerExists: playwrightBrowsersInstalled,
		probeHealth: (value) => isWorkerHealthOk(value),
		ports: workerPortRange(),
		origin,
	}
}

function readGitHooksPath() {
	try {
		const result = execFileSyncGit(['config', '--get', 'core.hooksPath'])
		return result || null
	} catch {
		return existsSync(path.join(process.cwd(), '.husky')) ? '.husky' : null
	}
}

function execFileSyncGit(args: Array<string>) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function printJson(value: unknown) {
	console.log(JSON.stringify(value, null, 2))
}

async function runCommand(options: ControlKodyOptions) {
	if (options.help || options.command === 'help') {
		console.log(usageLines.join('\n'))
		return 0
	}

	switch (options.command) {
		case 'doctor': {
			const report = await runDoctor(defaultDoctorDeps(options.origin))
			if (options.json) printJson(report)
			else {
				for (const check of report.checks) {
					console.log(
						`${check.ok ? 'ok' : 'FAIL'}  ${check.name}: ${check.detail}`,
					)
				}
			}
			return report.ok ? 0 : 1
		}
		case 'dev': {
			const result = await ensureDev(createDefaultEnsureDevDeps())
			if (options.json) printJson(result)
			else console.log(formatAppRunning(result.origin))
			return 0
		}
		case 'login': {
			const origin = await resolveOrigin(options)
			const defaults = credentialsForOrigin(origin)
			const session = await loginToOrigin({
				origin,
				email: options.email ?? defaults.email,
				password: options.password ?? defaults.password,
			})
			if (session.cookieHeader) {
				await writeCookieFile(options.cookieFile, session.cookieHeader)
			}
			if (options.json) {
				printJson({ ...session, cookieFile: options.cookieFile })
			} else {
				console.log(session.detail)
				if (session.ok) console.log(`cookie-file ${options.cookieFile}`)
			}
			return session.ok ? 0 : 1
		}
		case 'request': {
			if (!options.request) {
				throw new ControlKodyError(
					'request needs METHOD /path [status]. Example: request GET /account/waiting.json',
				)
			}
			const origin = await resolveOrigin(options)
			let cookieHeader = readCookieFile(options.cookieFile)
			if (!options.skipLogin && !cookieHeader) {
				const defaults = credentialsForOrigin(origin)
				const session = await loginToOrigin({
					origin,
					email: options.email ?? defaults.email,
					password: options.password ?? defaults.password,
				})
				cookieHeader = session.cookieHeader
				if (cookieHeader) {
					await writeCookieFile(options.cookieFile, cookieHeader)
				}
			}
			const result = await requestAsSession({
				origin,
				spec: options.request,
				cookieHeader,
			})
			if (options.json) printJson(result)
			else {
				console.log(`${result.detail} ${result.path}`)
				if (typeof result.body === 'string') console.log(result.body)
				else console.log(JSON.stringify(result.body, null, 2))
			}
			return result.ok ? 0 : 1
		}
		case 'preview': {
			const previewOptions = parsePreviewArgs(options.previewArgv)
			if (previewOptions.help) {
				await execFileAsync(resolveNpmCommand(), [
					'run',
					'preview:manual-test',
					'--',
					'--help',
				])
				return 0
			}
			const result = await runPreviewManualTest(previewOptions)
			return result.ok ? 0 : 1
		}
		case 'health': {
			const origin = await resolveOrigin(options)
			const result = await readHealth({
				origin,
				expectedSha: options.sha,
			})
			if (options.json) printJson(result)
			else
				console.log(`${result.ok ? 'ok' : 'FAIL'} ${origin} ${result.detail}`)
			return result.ok ? 0 : 1
		}
		case 'map': {
			if (options.check) {
				const root = repoRootFromHere()
				const report = runMapCheck({
					routeSource: readFileSync(defaultRoutesPath(root), 'utf8'),
					featuresDir: defaultFeaturesDir(root),
				})
				if (options.json) printJson(report)
				else if (report.ok) console.log('Feature Map matches routes.ts')
				else {
					for (const issue of report.issues) {
						console.error(issue.detail)
					}
				}
				return report.ok ? 0 : 1
			}
			if (options.featureId) {
				const feature = findFeature(featureCatalog, options.featureId)
				if (!feature) {
					throw new ControlKodyError(
						`Unknown feature ${options.featureId}. Run: node tools/control-kody.ts map`,
					)
				}
				const filePath = path.join(
					defaultFeaturesDir(repoRootFromHere()),
					feature.file,
				)
				if (options.json)
					printJson({ feature, body: readFileSync(filePath, 'utf8') })
				else console.log(readFileSync(filePath, 'utf8'))
				return 0
			}
			if (options.json) printJson(featureCatalog)
			else console.log(formatFeatureMap(featureCatalog))
			return 0
		}
		default: {
			const exhaustive: never = options.command
			throw new ControlKodyError(`Unhandled command ${String(exhaustive)}`)
		}
	}
}

export { usageLines }

if (isExecutedDirectly(import.meta.url)) {
	void runCommand(parseControlArgs(process.argv.slice(2)))
		.then((code) => {
			process.exit(code)
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error)
			process.exit(1)
		})
}
