import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
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
import { isExecutedDirectly } from './node-runtime.ts'
import {
	checkFeatureCatalog,
	featureCatalog,
	featuresDirRelativePath,
	findFeature,
	type Feature,
} from './control-kody/feature-catalog.ts'
import {
	createPreviewPackage,
	formatPackageCreateReport,
	isLowerKebabKodyId,
	isProductionKodyOrigin,
} from './control-kody/package-create.ts'
import {
	formatLocalAppDbRemediation,
	isLocalAppOrigin,
	withLocalAppDbRemediation,
} from './control-kody/local-app-db.ts'
import {
	defaultPlaywrightBrowsersJsonPath,
	inspectPlaywrightBrowsers,
	type PlaywrightBrowserCheck,
} from './control-kody/playwright-browsers.ts'
import {
	defaultDumpFile,
	formatContainsFailure,
	missingContainsNeedles,
} from './control-kody/request-proof.ts'
import {
	cookieHeaderForOrigin,
	formatCookieFile,
	shouldRefreshSession,
} from './control-kody/session-cookie.ts'
import {
	cookieHeaderFromSetCookie,
	evaluateAppHealth,
	parseSessionRequest,
	previewSeedEmail,
	previewSeedPassword,
	runPreviewManualTest,
	type SessionRequestSpec,
} from './preview-manual-test.ts'

export const localSeedEmail = 'jane@example.com'
export const localSeedPassword = 'ilikecode'
export const localAdminEmail = 'kody@example.com'
export const controlKodyUserAgent =
	'Mozilla/5.0 (compatible; KodyControlKody/1.0; +https://github.com/kentcdodds/kody)'

const usageLines = [
	'Usage: node tools/control-kody.ts <command> [options]',
	'',
	'Drive and verify the Kody app without throwaway scripts.',
	'',
	'Commands:',
	'  doctor          Check Node, Playwright browser revision, hooks, /health, and local APP_DB',
	'  dev             Start or reuse the local origin (npm run dev:ensure)',
	'  login           POST /auth and write a session cookie',
	'  request         Authenticated HTTP as the current session',
	'  preview         PR preview smoke (forwards flags to preview:manual-test)',
	'  health          GET /health and optionally assert commitSha',
	'  map             List or print a Feature Map entry; --check for drift',
	'  package-create  Create a stub saved package via MCP (preview data)',
	'',
	'Common options:',
	'  --origin <url>       App origin (default: healthy local 3742-3751)',
	'  --json               Machine-readable stdout',
	'  --cookie-file <p>    Session Cookie header file',
	'  --dump               Write the raw response body to .tmp/control-kody-body',
	'  --contains <text>    Fail unless the response body includes this text',
	'  --package-name <s>   Required for package-create (leaf or @scope/leaf)',
	'  --kody-id <slug>     Alias for --package-name',
	'  --description <t>    Optional package-create stub description',
	'  --head-ahead         package-create: push one unpublished commit',
	'  --help               Print this help',
	'',
	'preview forwards its flags to preview:manual-test (--pr, --request, --check).',
	'A `--` separator is optional. Example: preview --pr 42 --check /account',
	'',
	'request fetches GET/HEAD first and only POSTs /auth when the response is',
	'401 or login HTML. Public pages such as /pricing do not need a session.',
	'Mutating methods log in first when no cookie exists.',
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
	| 'package-create'
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
	dump: boolean
	dumpFile: string
	contains: Array<string>
	previewArgv: Array<string>
	kodyId: string | null
	description: string | null
	headAhead: boolean
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
		dump: false,
		dumpFile: defaultDumpFile(),
		contains: [],
		previewArgv: [],
		kodyId: null,
		description: null,
		headAhead: false,
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
		'package-create',
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
		if (separator === -1) {
			options.previewArgv = rest
		} else {
			options.previewArgv = rest.slice(separator + 1)
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
			case '--dump': {
				options.dump = true
				break
			}
			case '--contains': {
				options.contains.push(requireValue(argv[index + 1], '--contains'))
				index += 1
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
			case '--package-name': {
				options.kodyId = requireValue(argv[index + 1], '--package-name')
				index += 1
				break
			}
			case '--kody-id': {
				options.kodyId = requireValue(argv[index + 1], '--kody-id')
				index += 1
				break
			}
			case '--description': {
				options.description = requireValue(argv[index + 1], '--description')
				index += 1
				break
			}
			case '--head-ahead': {
				options.headAhead = true
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

export type LocalLoginProbe = {
	ok: boolean
	status: number | null
	detail: string
	email?: string
}

export type DoctorDeps = {
	nodeVersion: string
	homeDir: string
	hooksPath: string | null
	inspectPlaywright: (homeDir: string) => PlaywrightBrowserCheck
	probeHealth: (origin: string) => Promise<boolean>
	ports: ReadonlyArray<number>
	origin: string | null
	persistRoot: string
	probeLocalLogin?: (origin: string) => Promise<LocalLoginProbe>
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

	const playwright = deps.inspectPlaywright(deps.homeDir)
	checks.push({
		name: 'playwright',
		ok: playwright.ok,
		detail: playwright.detail,
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

	checks.push(await runLocalAppDbCheck(deps, origin))

	return { ok: checks.every((check) => check.ok), checks }
}

async function runLocalAppDbCheck(
	deps: DoctorDeps,
	origin: string | null,
): Promise<DoctorCheck> {
	if (origin && !isLocalAppOrigin(origin)) {
		return {
			name: 'local-d1',
			ok: true,
			detail: 'skipped (non-local origin)',
		}
	}

	if (origin && deps.probeLocalLogin) {
		try {
			const probe = await deps.probeLocalLogin(origin)
			if (probe.ok) {
				return {
					name: 'local-d1',
					ok: true,
					detail: `local seed login ok (${probe.email ?? localSeedEmail})`,
				}
			}
			return {
				name: 'local-d1',
				ok: false,
				detail: withLocalAppDbRemediation(
					origin,
					probe,
					localAppDbSeedEmails(),
				),
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			return {
				name: 'local-d1',
				ok: false,
				detail: withLocalAppDbRemediation(
					origin,
					{ status: null, detail, email: localSeedEmail },
					localAppDbSeedEmails(),
				),
			}
		}
	}

	const persistOk = existsSync(deps.persistRoot)
	if (persistOk) {
		return {
			name: 'local-d1',
			ok: true,
			detail:
				'local persist present; if login fails, run npm run migrate:local && node tools/seed-test-data.ts --local',
		}
	}
	return {
		name: 'local-d1',
		ok: false,
		detail: `no local Wrangler persist at ${deps.persistRoot}\n${formatLocalAppDbRemediation()}`,
	}
}

function localAppDbSeedEmails() {
	return [localSeedEmail, localAdminEmail]
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
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': controlKodyUserAgent,
		},
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
	rawBody: string
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
		'User-Agent': controlKodyUserAgent,
	}
	if (input.cookieHeader) headers.Cookie = input.cookieHeader
	if (input.spec.body !== null) headers['Content-Type'] = 'application/json'
	const response = await fetchImpl(`${input.origin}${input.spec.path}`, {
		method: input.spec.method,
		headers,
		body:
			input.spec.body === null ? undefined : JSON.stringify(input.spec.body),
	})
	const rawBody = await response.text()
	let body: unknown = rawBody
	try {
		body = JSON.parse(rawBody) as unknown
	} catch {
		body = rawBody
	}
	const expected = input.spec.expectedStatus
	const ok = expected === null ? response.ok : response.status === expected
	return {
		ok,
		status: response.status,
		path: input.spec.path,
		body,
		rawBody,
		detail: ok
			? `HTTP ${response.status}`
			: `expected ${expected ?? '2xx'}, got HTTP ${response.status}`,
	}
}

export function isGitAncestor(
	ancestor: string,
	descendant: string,
	options: {
		execFile?: typeof execFileSync
		cwd?: string
	} = {},
) {
	const execFile = options.execFile ?? execFileSync
	try {
		execFile('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
			cwd: options.cwd ?? process.cwd(),
			stdio: 'ignore',
		})
		return true
	} catch {
		return false
	}
}

export async function readHealth(input: {
	origin: string
	expectedSha: string | null
	fetchImpl?: typeof fetch
	isAncestor?: (ancestor: string, descendant: string) => boolean
}) {
	const fetchImpl = input.fetchImpl ?? fetch
	const response = await fetchImpl(healthUrlForOrigin(input.origin), {
		headers: { 'User-Agent': controlKodyUserAgent },
	})
	let body: unknown = null
	try {
		body = await response.json()
	} catch {
		body = null
	}
	let evaluated = evaluateAppHealth(body, input.expectedSha)
	if (
		!evaluated.ok &&
		input.expectedSha &&
		evaluated.commitSha &&
		response.ok
	) {
		const isAncestor = input.isAncestor ?? isGitAncestor
		if (isAncestor(input.expectedSha, evaluated.commitSha)) {
			evaluated = {
				ok: true,
				commitSha: evaluated.commitSha,
				detail: `ok, commitSha ${evaluated.commitSha} (descendant of ${input.expectedSha})`,
			}
		}
	}
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

export function readCookieFile(cookieFile: string, origin: string) {
	if (!existsSync(cookieFile)) return null
	return cookieHeaderForOrigin(readFileSync(cookieFile, 'utf8'), origin)
}

export async function writeCookieFile(
	cookieFile: string,
	cookieHeader: string,
	origin: string,
) {
	await mkdir(path.dirname(cookieFile), { recursive: true })
	await writeFile(cookieFile, formatCookieFile(origin, cookieHeader), {
		mode: 0o600,
	})
	await chmod(cookieFile, 0o600)
}

async function writeDumpFile(dumpFile: string, rawBody: string) {
	await mkdir(path.dirname(dumpFile), { recursive: true })
	await writeFile(dumpFile, rawBody, { mode: 0o600 })
	await chmod(dumpFile, 0o600)
}

async function loginAndStoreCookie(
	origin: string,
	options: ControlKodyOptions,
): Promise<{ ok: true; cookieHeader: string } | { ok: false }> {
	const defaults = credentialsForOrigin(origin)
	const session = await loginToOrigin({
		origin,
		email: options.email ?? defaults.email,
		password: options.password ?? defaults.password,
	})
	if (!session.ok || !session.cookieHeader) {
		const detail = withLocalAppDbRemediation(
			origin,
			session,
			localAppDbSeedEmails(),
		)
		if (options.json) printJson({ ...session, detail })
		else console.error(detail)
		return { ok: false }
	}
	await writeCookieFile(options.cookieFile, session.cookieHeader, origin)
	return { ok: true, cookieHeader: session.cookieHeader }
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
		inspectPlaywright: (homeDir) =>
			inspectPlaywrightBrowsers({
				homeDir,
				browsersJsonPath: defaultPlaywrightBrowsersJsonPath(repoRootFromHere()),
			}),
		probeHealth: (value) => isWorkerHealthOk(value),
		ports: workerPortRange(),
		origin,
		persistRoot: path.join(process.cwd(), '.wrangler', 'state'),
		probeLocalLogin: async (value) => {
			const session = await loginToOrigin({
				origin: value,
				email: localSeedEmail,
				password: localSeedPassword,
			})
			return {
				ok: session.ok,
				status: session.status,
				detail: session.detail,
				email: session.email,
			}
		},
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
			const detail = session.ok
				? session.detail
				: withLocalAppDbRemediation(origin, session, localAppDbSeedEmails())
			if (session.cookieHeader) {
				await writeCookieFile(options.cookieFile, session.cookieHeader, origin)
			}
			if (options.json) {
				printJson({ ...session, detail, cookieFile: options.cookieFile })
			} else {
				console.log(detail)
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
			let cookieHeader = readCookieFile(options.cookieFile, origin)
			const method = options.request.method.toUpperCase()
			if (
				!options.skipLogin &&
				!cookieHeader &&
				method !== 'GET' &&
				method !== 'HEAD'
			) {
				const loggedIn = await loginAndStoreCookie(origin, options)
				if (!loggedIn.ok) return 1
				cookieHeader = loggedIn.cookieHeader
			}
			let result = await requestAsSession({
				origin,
				spec: options.request,
				cookieHeader,
			})
			if (
				shouldRefreshSession({
					skipLogin: options.skipLogin,
					status: result.status,
					path: options.request.path,
					rawBody: result.rawBody,
					method: options.request.method,
				})
			) {
				const loggedIn = await loginAndStoreCookie(origin, options)
				if (!loggedIn.ok) return 1
				cookieHeader = loggedIn.cookieHeader
				result = await requestAsSession({
					origin,
					spec: options.request,
					cookieHeader,
				})
			}
			const rawBody = result.rawBody
			const missing = missingContainsNeedles(rawBody, options.contains)
			let dumpFile: string | null = null
			if (options.dump) {
				await writeDumpFile(options.dumpFile, rawBody)
				dumpFile = options.dumpFile
			}
			const ok = result.ok && missing.length === 0
			const detail = [
				result.detail,
				dumpFile ? `dumped ${dumpFile}` : null,
				missing.length > 0 ? formatContainsFailure(missing) : null,
			]
				.filter((part): part is string => Boolean(part))
				.join('\n')
			const output = {
				...result,
				ok,
				detail,
				dumpFile,
				contains: options.contains.map((needle) => ({
					needle,
					ok: !missing.includes(needle),
				})),
			}
			if (options.json) printJson(output)
			else {
				console.log(`${output.detail} ${output.path}`)
				if (options.dump || typeof result.body === 'string') {
					console.log(rawBody)
				} else console.log(JSON.stringify(result.body, null, 2))
			}
			return output.ok ? 0 : 1
		}
		case 'preview': {
			const result = await runPreviewManualTest(options.previewArgv)
			return result.exitCode
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
		case 'package-create': {
			if (!options.kodyId) {
				throw new ControlKodyError(
					'package-create requires --package-name <leaf-or-@scope/leaf>',
				)
			}
			if (!isLowerKebabKodyId(options.kodyId)) {
				throw new ControlKodyError(
					'--package-name must be a lower-kebab-case leaf or @scope/leaf (for example "preview-pkg")',
				)
			}
			const origin = await resolveOrigin(options)
			if (isProductionKodyOrigin(origin)) {
				throw new ControlKodyError(
					'package-create refuses to run against https://kody.codes',
				)
			}
			const defaults = credentialsForOrigin(origin)
			const report = await createPreviewPackage({
				origin,
				email: options.email ?? defaults.email,
				password: options.password ?? defaults.password,
				kodyId: options.kodyId,
				description: options.description,
				headAhead: options.headAhead,
			})
			if (report.cookieHeader) {
				await writeCookieFile(options.cookieFile, report.cookieHeader, origin)
			}
			if (options.json) {
				const { cookieHeader: _cookieHeader, ...publicReport } = report
				printJson({ ...publicReport, cookieFile: options.cookieFile })
			} else {
				console.log(formatPackageCreateReport(report))
				console.log(`cookie-file ${options.cookieFile}`)
			}
			return 0
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

export { usageLines, runCommand }

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
