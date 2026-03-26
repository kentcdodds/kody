import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import getPort, { clearLockedPorts } from 'get-port'
import { getRemoteAiLocalDevStartupError } from '@kody-internal/shared/ai-env-validation.ts'
import {
	spawnInOwnProcessGroup,
	stopChildProcessTree,
} from './tools/dev-process-utils.ts'
import {
	createProcessOutputController,
	type ProcessOutputMode,
} from './tools/dev-process-output.ts'
import { getForwardedHomeConnectorEnv } from './tools/home-connector-env.ts'
import { resolveNpmCommand } from './tools/node-runtime.ts'

const defaultWorkerPort = 3742
const defaultMockPort = 8788
const mockReadyTimeoutMs = 10_000
const mockReadyPollMs = 200
const workerReadyTimeoutMs = 15_000
const workerReadyPollMs = 250

const ansiReset = '\x1b[0m'
const ansiBright = '\x1b[1m'
const ansiDim = '\x1b[2m'
const colorCodes = {
	cyan: '\x1b[36m',
	green: '\x1b[32m',
	cornflowerblue: '\x1b[38;2;100;149;237m',
	yellow: '\x1b[33m',
	orange: '\x1b[38;2;255;165;0m',
	magenta: '\x1b[35m',
	firebrick: '\x1b[38;2;178;34;34m',
} as const

function colorize(text: string, color: keyof typeof colorCodes) {
	const colorCode = colorCodes[color] ?? ''
	return colorCode ? `${colorCode}${text}${ansiReset}` : text
}

function bright(text: string) {
	return `${ansiBright}${text}${ansiReset}`
}

function dim(text: string) {
	return `${ansiDim}${text}${ansiReset}`
}

type OutputFilterKey = 'client' | 'worker' | 'default'

type ChildOutputConfig = {
	filterKey?: OutputFilterKey
	label?: string
	mode?: ProcessOutputMode
}

const outputFilters: Record<OutputFilterKey, Array<RegExp>> = {
	client: [],
	worker: [],
	default: [],
}

const extraArgs = process.argv.slice(2)
let shutdown: (() => void) | null = null
let devChildren: Array<ChildProcess> = []
let workerOrigin = ''
let homeConnectorOrigin = ''
let mockResendProcess: ChildProcess | null = null
let mockAiProcess: ChildProcess | null = null
let mockGithubProcess: ChildProcess | null = null
let mockCloudflareProcess: ChildProcess | null = null
let mockCursorProcess: ChildProcess | null = null
let mockEnvOverrides: Record<string, string> = {}

void startDev().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
})

async function startDev() {
	const startupError = getRemoteAiLocalDevStartupError(process.env)
	if (startupError) {
		throw new Error(startupError)
	}
	await restartDev({ announce: false })
	setupInteractiveCli({
		getWorkerOrigin: () => workerOrigin,
		restart: restartDev,
	})
	shutdown = setupShutdown(
		() => devChildren,
		() =>
			[
				mockResendProcess,
				mockAiProcess,
				mockGithubProcess,
				mockCloudflareProcess,
				mockCursorProcess,
			].filter(Boolean) as Array<ChildProcess>,
	)
}

function resolveWorkerOrigin(port: number) {
	const envOrigin = process.env.WORKER_DEV_ORIGIN
	if (envOrigin) return envOrigin.trim()
	return `http://localhost:${port}`
}

function runNpmScript(
	script: string,
	args: Array<string> = [],
	envOverrides: Record<string, string> = {},
	options: ChildOutputConfig = {},
): ChildProcess {
	const outputConfig = {
		filterKey: options.filterKey ?? 'default',
		label: options.label ?? script,
		mode: options.mode ?? 'live',
	} satisfies Required<ChildOutputConfig>
	const child = spawnInOwnProcessGroup(
		resolveNpmCommand(),
		['run', '--silent', script, '--', ...args],
		{
			stdio: ['inherit', 'pipe', 'pipe'],
			env: { ...process.env, ...envOverrides },
		},
	)

	pipeOutput(child, {
		...outputConfig,
	})

	child.on('exit', (code, signal) => {
		if (signal) return
		if (code && code !== 0) {
			process.exitCode = code
		}
	})

	return child
}

function pipeOutput(child: ChildProcess, options: Required<ChildOutputConfig>) {
	const controller = createProcessOutputController({
		label: options.label,
		mode: options.mode,
		filters: outputFilters[options.filterKey],
	})

	if (child.stdout) {
		pipeStream(child.stdout, 'stdout', controller.writeLine)
	}
	if (child.stderr) {
		pipeStream(child.stderr, 'stderr', controller.writeLine)
	}

	child.on('close', (code, signal) => {
		controller.handleExit({ code, signal })
	})
}

function pipeStream(
	source: NodeJS.ReadableStream,
	target: 'stdout' | 'stderr',
	writeLine: (target: 'stdout' | 'stderr', line: string) => void,
) {
	const rl = readline.createInterface({ input: source })
	rl.on('line', (line) => {
		writeLine(target, line)
	})
}

function setupShutdown(
	getChildren: () => Array<ChildProcess>,
	getMockProcesses: () => Array<ChildProcess>,
) {
	let isShuttingDown = false
	function doShutdown() {
		if (isShuttingDown) return
		isShuttingDown = true
		console.log(dim('\nShutting down...'))
		const children = getChildren().filter((child) => child.exitCode === null)
		for (const mockProcess of getMockProcesses()) {
			if (mockProcess.exitCode === null) {
				children.push(mockProcess)
			}
		}
		void (async () => {
			await Promise.all(children.map((child) => stopChild(child)))
			process.exit(0)
		})()
	}

	process.on('SIGINT', doShutdown)
	process.on('SIGTERM', doShutdown)
	return doShutdown
}

function setupInteractiveCli(options: {
	getWorkerOrigin: () => string
	restart: () => Promise<void>
}) {
	const stdin = process.stdin
	if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return

	showHelp()
	logAppRunning(options.getWorkerOrigin)

	readline.emitKeypressEvents(stdin)
	stdin.setRawMode(true)
	stdin.resume()

	stdin.on('keypress', (_key, key) => {
		if (key?.ctrl && key.name === 'c') {
			shutdown?.()
			return
		}

		if (key?.name === 'return') {
			process.stdout.write('\n')
			return
		}

		switch (key?.name) {
			case 'o': {
				openInBrowser(options.getWorkerOrigin())
				break
			}
			case 'u': {
				copyToClipboard(options.getWorkerOrigin())
				break
			}
			case 'c': {
				console.clear()
				showHelp()
				logAppRunning(options.getWorkerOrigin)
				break
			}
			case 'r': {
				void options.restart()
				break
			}
			case 'h':
			case '?': {
				showHelp()
				break
			}
			case 'q': {
				shutdown?.()
				break
			}
		}
	})
}

function showHelp(header?: string) {
	if (header) console.log(header)
	console.log(`\n${bright('CLI shortcuts:')}`)
	console.log(
		`  ${colorize('o', 'cyan')} - ${colorize('open browser', 'green')}`,
	)
	console.log(
		`  ${colorize('u', 'cyan')} - ${colorize('copy URL', 'cornflowerblue')}`,
	)
	console.log(
		`  ${colorize('c', 'cyan')} - ${colorize('clear console', 'yellow')}`,
	)
	console.log(`  ${colorize('r', 'cyan')} - ${colorize('restart', 'orange')}`)
	console.log(`  ${colorize('h', 'cyan')} - ${colorize('help', 'magenta')}`)
	console.log(`  ${colorize('q', 'cyan')} - ${colorize('quit', 'firebrick')}`)
}

async function restartDev(
	{ announce }: { announce: boolean } = { announce: true },
) {
	await stopChildren(devChildren)
	const mockEnv = await ensureMockServers()
	const desiredPort = Number.parseInt(
		process.env.PORT ?? String(defaultWorkerPort),
		10,
	)
	const portRange = Array.from(
		{ length: 10 },
		(_, index) => desiredPort + index,
	)
	clearLockedPorts()
	const workerPort = await getPort({ port: portRange })
	workerOrigin = resolveWorkerOrigin(workerPort)
	const homeConnectorId = process.env.HOME_CONNECTOR_ID?.trim() || 'default'
	const homeConnectorSharedSecret =
		process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() ||
		`local-home-connector-${randomUUID()}`
	const desiredHomeConnectorPort = Number.parseInt(
		process.env.HOME_CONNECTOR_PORT ?? '4040',
		10,
	)
	const homeConnectorPortRange = Array.from(
		{ length: 10 },
		(_, index) => desiredHomeConnectorPort + index,
	)
	const homeConnectorPort = await getPort({ port: homeConnectorPortRange })
	homeConnectorOrigin = `http://localhost:${homeConnectorPort}`
	const forwardedHomeConnectorEnv = getForwardedHomeConnectorEnv(process.env)
	const client = runNpmScript(
		'dev:client',
		[],
		{},
		{
			filterKey: 'client',
			label: 'dev:client',
			mode: 'buffer-on-error',
		},
	)
	const workerVarEnv = {
		...mockEnv,
		HOME_CONNECTOR_SHARED_SECRET: homeConnectorSharedSecret,
	}
	const workerVarArgs = Object.entries(workerVarEnv).flatMap(([key, value]) => [
		'--var',
		`${key}:${value}`,
	])
	const worker = runNpmScript(
		'dev:worker',
		[...extraArgs, ...workerVarArgs],
		{
			PORT: String(workerPort),
			HOME_CONNECTOR_SHARED_SECRET: homeConnectorSharedSecret,
			...mockEnv,
		},
		{
			filterKey: 'worker',
			label: 'dev:worker',
			mode: 'live',
		},
	)
	const workerDidStart = await waitForWorkerReady(workerOrigin, worker)
	if (!workerDidStart) {
		console.warn(
			`Main worker did not become ready within ${workerReadyTimeoutMs}ms.`,
		)
	}
	const homeConnector = runNpmScript(
		'dev:home-connector',
		[],
		{
			...forwardedHomeConnectorEnv,
			PORT: String(homeConnectorPort),
			HOME_CONNECTOR_ID: homeConnectorId,
			HOME_CONNECTOR_SHARED_SECRET: homeConnectorSharedSecret,
			WORKER_BASE_URL: workerOrigin,
		},
		{
			label: 'dev:home-connector',
			mode: 'live',
		},
	)
	devChildren = [client, worker, homeConnector]

	if (announce) {
		console.log(dim('\nRestarted dev servers.'))
		logAppRunning(() => workerOrigin)
		console.log(
			`${dim('Home connector running at')} ${bright(homeConnectorOrigin)}`,
		)
	}
}

function hasEnvValue(value: string | undefined) {
	return typeof value === 'string' && value.trim().length > 0
}

function resolveAiMode() {
	return process.env.AI_MODE?.trim() === 'remote' ? 'remote' : 'mock'
}

function isChildRunning(child: ChildProcess | null) {
	return Boolean(child && !child.killed && child.exitCode === null)
}

async function isMockReady(baseUrl: string) {
	try {
		const response = await fetch(`${baseUrl}/__mocks/meta`)
		await response.body?.cancel()
		return response.ok
	} catch {
		return false
	}
}

async function waitForMockReady(baseUrl: string, child: ChildProcess) {
	const start = Date.now()
	while (Date.now() - start < mockReadyTimeoutMs) {
		if (child.killed || child.exitCode !== null) {
			return false
		}
		if (await isMockReady(baseUrl)) {
			return true
		}
		await delay(mockReadyPollMs)
	}
	return false
}

async function isWorkerReady(workerOrigin: string) {
	try {
		const response = await fetch(`${workerOrigin}/health`)
		await response.body?.cancel()
		return response.ok
	} catch {
		return false
	}
}

async function waitForWorkerReady(workerOrigin: string, child: ChildProcess) {
	const start = Date.now()
	while (Date.now() - start < workerReadyTimeoutMs) {
		if (child.killed || child.exitCode !== null) {
			return false
		}
		if (await isWorkerReady(workerOrigin)) {
			return true
		}
		await delay(workerReadyPollMs)
	}
	return false
}

async function attachGithubMock(
	mockEnv: Record<string, string>,
	anchorPort: number,
) {
	if (process.env.SKIP_GITHUB_MOCK?.trim() === '1') {
		return
	}
	if (
		hasEnvValue(mockEnv.GITHUB_API_BASE_URL) &&
		isChildRunning(mockGithubProcess)
	) {
		return
	}
	if (mockGithubProcess && !mockGithubProcess.killed) {
		await stopChild(mockGithubProcess)
		mockGithubProcess = null
	}
	const githubPort = await getPort({
		port: Array.from({ length: 20 }, (_, index) => anchorPort + 40 + index),
	})
	const baseUrl = `http://127.0.0.1:${githubPort}`
	const apiToken = `mock-github-${randomUUID()}`
	const child = runNpmScript(
		'dev:mock-github',
		[
			'--port',
			String(githubPort),
			'--ip',
			'127.0.0.1',
			'--var',
			`MOCK_API_TOKEN:${apiToken}`,
		],
		{},
		{
			label: 'dev:mock-github',
			mode: 'buffer-on-error',
		},
	)
	mockGithubProcess = child
	child.once('exit', () => {
		if (mockGithubProcess === child) {
			mockGithubProcess = null
		}
	})
	mockEnv.GITHUB_API_BASE_URL = baseUrl
	mockEnv.GITHUB_TOKEN = apiToken
	const didStart = await waitForMockReady(baseUrl, child)
	if (!didStart) {
		console.warn(
			`Mock GitHub worker did not become ready within ${mockReadyTimeoutMs}ms.`,
		)
	}
	console.log(dim(`GitHub mock base URL ${baseUrl}`))
}

async function attachCursorMock(
	mockEnv: Record<string, string>,
	anchorPort: number,
) {
	if (process.env.SKIP_CURSOR_MOCK?.trim() === '1') {
		return
	}
	if (
		hasEnvValue(mockEnv.CURSOR_API_BASE_URL) &&
		isChildRunning(mockCursorProcess)
	) {
		return
	}
	if (mockCursorProcess && !mockCursorProcess.killed) {
		await stopChild(mockCursorProcess)
		mockCursorProcess = null
	}
	const cursorPort = await getPort({
		port: Array.from({ length: 20 }, (_, index) => anchorPort + 140 + index),
	})
	const baseUrl = `http://127.0.0.1:${cursorPort}`
	const apiToken = `mock-cursor-${randomUUID()}`
	const child = runNpmScript(
		'dev:mock-cursor',
		[
			'--port',
			String(cursorPort),
			'--ip',
			'127.0.0.1',
			'--var',
			`MOCK_API_TOKEN:${apiToken}`,
		],
		{},
		{
			label: 'dev:mock-cursor',
			mode: 'buffer-on-error',
		},
	)
	mockCursorProcess = child
	child.once('exit', () => {
		if (mockCursorProcess === child) {
			mockCursorProcess = null
		}
	})
	mockEnv.CURSOR_API_BASE_URL = baseUrl
	mockEnv.CURSOR_API_KEY = apiToken
	const didStart = await waitForMockReady(baseUrl, child)
	if (!didStart) {
		console.warn(
			`Mock Cursor Cloud worker did not become ready within ${mockReadyTimeoutMs}ms.`,
		)
	}
	console.log(dim(`Cursor Cloud mock base URL ${baseUrl}`))
}

async function attachCloudflareMock(
	mockEnv: Record<string, string>,
	anchorPort: number,
) {
	if (process.env.SKIP_CLOUDFLARE_MOCK?.trim() === '1') {
		return
	}
	const shouldPreserveRealToken = resolveAiMode() === 'remote'
	if (shouldPreserveRealToken) {
		return
	}
	if (
		hasEnvValue(mockEnv.CLOUDFLARE_API_BASE_URL) &&
		isChildRunning(mockCloudflareProcess)
	) {
		return
	}
	if (mockCloudflareProcess && !mockCloudflareProcess.killed) {
		await stopChild(mockCloudflareProcess)
		mockCloudflareProcess = null
	}
	const cloudflarePort = await getPort({
		port: Array.from({ length: 20 }, (_, index) => anchorPort + 240 + index),
	})
	const baseUrl = `http://127.0.0.1:${cloudflarePort}`
	const apiToken = `mock-cloudflare-${randomUUID()}`
	const child = runNpmScript(
		'dev:mock-cloudflare',
		[
			'--port',
			String(cloudflarePort),
			'--ip',
			'127.0.0.1',
			'--var',
			`MOCK_API_TOKEN:${apiToken}`,
		],
		{},
		{
			label: 'dev:mock-cloudflare',
			mode: 'buffer-on-error',
		},
	)
	mockCloudflareProcess = child
	child.once('exit', () => {
		if (mockCloudflareProcess === child) {
			mockCloudflareProcess = null
		}
	})
	mockEnv.CLOUDFLARE_API_BASE_URL = baseUrl
	mockEnv.CLOUDFLARE_API_TOKEN = apiToken
	const didStart = await waitForMockReady(baseUrl, child)
	if (!didStart) {
		console.warn(
			`Mock Cloudflare worker did not become ready within ${mockReadyTimeoutMs}ms.`,
		)
	}
	console.log(dim(`Cloudflare mock base URL ${baseUrl}`))
}

async function ensureMockServers() {
	const previousMockEnvOverrides = { ...mockEnvOverrides }
	const desiredAiMode = resolveAiMode()
	const canReuseResendMock = isChildRunning(mockResendProcess)
	const canReuseAiMock = isChildRunning(mockAiProcess)
	const hasMatchingCachedMode = mockEnvOverrides.AI_MODE === desiredAiMode
	const canReuseCachedResendEnv =
		canReuseResendMock &&
		hasEnvValue(mockEnvOverrides.RESEND_API_BASE_URL) &&
		hasEnvValue(mockEnvOverrides.RESEND_API_KEY)
	const canReuseCachedAiEnv =
		canReuseAiMock &&
		hasEnvValue(previousMockEnvOverrides.AI_MOCK_BASE_URL) &&
		hasEnvValue(previousMockEnvOverrides.AI_MOCK_API_KEY)

	if (
		canReuseCachedResendEnv &&
		hasMatchingCachedMode &&
		(desiredAiMode === 'remote' || canReuseCachedAiEnv)
	) {
		const resendForAnchor = new URL(
			mockEnvOverrides.RESEND_API_BASE_URL ??
				`http://127.0.0.1:${defaultMockPort}`,
		)
		const anchorFromReuse = Number.parseInt(
			resendForAnchor.port || String(defaultMockPort),
			10,
		)
		await attachGithubMock(mockEnvOverrides, anchorFromReuse)
		await attachCloudflareMock(mockEnvOverrides, anchorFromReuse)
		await attachCursorMock(mockEnvOverrides, anchorFromReuse)
		return mockEnvOverrides
	}

	if (!canReuseResendMock && mockAiProcess && !mockAiProcess.killed) {
		await stopChild(mockAiProcess)
		mockAiProcess = null
	}
	let mockPort: number
	if (canReuseCachedResendEnv) {
		const resendBaseUrl = new URL(mockEnvOverrides.RESEND_API_BASE_URL ?? '')
		const parsedResendPort = Number.parseInt(
			resendBaseUrl.port || String(defaultMockPort),
			10,
		)
		mockPort = Number.isNaN(parsedResendPort)
			? defaultMockPort
			: parsedResendPort
		mockEnvOverrides = {
			...mockEnvOverrides,
			AI_MODE: desiredAiMode,
		}
	} else {
		const desiredPort = Number.parseInt(
			process.env.MOCK_API_PORT ?? String(defaultMockPort),
			10,
		)
		const portRange = Array.from(
			{ length: 10 },
			(_, index) => desiredPort + index,
		)
		mockPort = await getPort({ port: portRange })
		if (mockGithubProcess && !mockGithubProcess.killed) {
			await stopChild(mockGithubProcess)
			mockGithubProcess = null
		}
		if (mockCloudflareProcess && !mockCloudflareProcess.killed) {
			await stopChild(mockCloudflareProcess)
			mockCloudflareProcess = null
		}
		if (mockCursorProcess && !mockCursorProcess.killed) {
			await stopChild(mockCursorProcess)
			mockCursorProcess = null
		}
		const baseUrl = `http://127.0.0.1:${mockPort}`
		const apiToken = `mock-resend-${randomUUID()}`
		const child = runNpmScript(
			'dev:mock-resend',
			[
				'--port',
				String(mockPort),
				'--ip',
				'127.0.0.1',
				'--var',
				`MOCK_API_TOKEN:${apiToken}`,
			],
			{},
			{
				label: 'dev:mock-resend',
				mode: 'buffer-on-error',
			},
		)
		mockResendProcess = child
		child.once('exit', () => {
			if (mockResendProcess === child) {
				mockResendProcess = null
			}
		})
		mockEnvOverrides = {
			RESEND_API_BASE_URL: baseUrl,
			RESEND_API_KEY: apiToken,
			AI_MODE: desiredAiMode,
		}
		if (!hasEnvValue(process.env.RESEND_FROM_EMAIL)) {
			mockEnvOverrides.RESEND_FROM_EMAIL = 'reset@kody.dev'
		}
		const didStart = await waitForMockReady(baseUrl, child)
		if (!didStart) {
			console.warn(
				`Mock API worker did not become ready within ${mockReadyTimeoutMs}ms.`,
			)
		}
		console.log(dim(`Mock API worker running at ${baseUrl}`))
		console.log(dim(`Resend mock base URL ${baseUrl}`))
	}

	if (desiredAiMode === 'mock') {
		if (canReuseCachedAiEnv) {
			mockEnvOverrides.AI_MOCK_BASE_URL =
				previousMockEnvOverrides.AI_MOCK_BASE_URL ?? ''
			mockEnvOverrides.AI_MOCK_API_KEY =
				previousMockEnvOverrides.AI_MOCK_API_KEY ?? ''
			await attachGithubMock(mockEnvOverrides, mockPort)
			await attachCloudflareMock(mockEnvOverrides, mockPort)
			await attachCursorMock(mockEnvOverrides, mockPort)
			return mockEnvOverrides
		}
		const aiPort = await getPort({
			port: Array.from({ length: 10 }, (_, index) => mockPort + 10 + index),
		})
		const aiBaseUrl = `http://127.0.0.1:${aiPort}`
		const aiApiToken = `mock-ai-${randomUUID()}`
		const aiChild = runNpmScript(
			'dev:mock-ai',
			[
				'--port',
				String(aiPort),
				'--ip',
				'127.0.0.1',
				'--var',
				`MOCK_API_TOKEN:${aiApiToken}`,
			],
			{},
			{
				label: 'dev:mock-ai',
				mode: 'buffer-on-error',
			},
		)
		mockAiProcess = aiChild
		aiChild.once('exit', () => {
			if (mockAiProcess === aiChild) {
				mockAiProcess = null
			}
		})
		mockEnvOverrides.AI_MOCK_BASE_URL = aiBaseUrl
		mockEnvOverrides.AI_MOCK_API_KEY = aiApiToken
		const aiDidStart = await waitForMockReady(aiBaseUrl, aiChild)
		if (!aiDidStart) {
			console.warn(
				`Mock AI worker did not become ready within ${mockReadyTimeoutMs}ms.`,
			)
		}
		console.log(dim(`AI mock base URL ${aiBaseUrl}`))
	} else {
		if (mockAiProcess && !mockAiProcess.killed) {
			await stopChild(mockAiProcess)
			mockAiProcess = null
		}
		mockEnvOverrides.AI_MOCK_BASE_URL = ''
		mockEnvOverrides.AI_MOCK_API_KEY = ''
	}

	await attachGithubMock(mockEnvOverrides, mockPort)
	await attachCloudflareMock(mockEnvOverrides, mockPort)
	await attachCursorMock(mockEnvOverrides, mockPort)

	return mockEnvOverrides
}

async function stopChildren(children: Array<ChildProcess>) {
	await Promise.all(children.map((child) => stopChild(child)))
}

async function stopChild(child: ChildProcess) {
	await stopChildProcessTree(child)
}

function logAppRunning(getOrigin: () => string) {
	console.log(`\n${dim('App running at')} ${bright(getOrigin())}`)
}

function openInBrowser(url: string) {
	const os = platform()
	if (os === 'darwin') {
		spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
		return
	}

	if (os === 'win32') {
		spawn('cmd', ['/c', 'start', url], {
			stdio: 'ignore',
			detached: true,
		}).unref()
		return
	}

	spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
}

function copyToClipboard(text: string) {
	const os = platform()
	if (os === 'darwin') {
		const proc = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
		proc.stdin?.write(text)
		proc.stdin?.end()
		return
	}

	if (os === 'win32') {
		const proc = spawn('clip', [], { stdio: ['pipe', 'ignore', 'ignore'] })
		proc.stdin?.write(text)
		proc.stdin?.end()
		return
	}

	const proc = spawn('xclip', ['-selection', 'clipboard'], {
		stdio: ['pipe', 'ignore', 'ignore'],
	})
	proc.stdin?.write(text)
	proc.stdin?.end()
}
