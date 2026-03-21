import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import getPort, { clearLockedPorts } from 'get-port'
import { getRemoteAiLocalDevStartupError } from '@kody-internal/shared/ai-env-validation.ts'

const defaultWorkerPort = 3742
const defaultMockPort = 8788
const mockReadyTimeoutMs = 10_000
const mockReadyPollMs = 200

const ansiReset = '\x1b[0m'
const ansiBright = '\x1b[1m'
const ansiDim = '\x1b[2m'

function colorize(text: string, color: string) {
	const bunColor = typeof Bun === 'undefined' ? null : Bun.color
	const colorCode = bunColor ? bunColor(color, 'ansi-16m') || '' : ''
	return colorCode ? `${colorCode}${text}${ansiReset}` : text
}

function bright(text: string) {
	return `${ansiBright}${text}${ansiReset}`
}

function dim(text: string) {
	return `${ansiDim}${text}${ansiReset}`
}

type OutputFilterKey = 'client' | 'worker' | 'default'

const outputFilters: Record<OutputFilterKey, Array<RegExp>> = {
	client: [],
	worker: [],
	default: [],
}

const extraArgs = process.argv.slice(2)
let shutdown: (() => void) | null = null
let devChildren: Array<ChildProcess> = []
let workerOrigin = ''
let mockResendProcess: ChildProcess | null = null
let mockAiProcess: ChildProcess | null = null
let mockGithubProcess: ChildProcess | null = null
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
				mockCursorProcess,
			].filter(Boolean) as Array<ChildProcess>,
	)
}

function resolveWorkerOrigin(port: number) {
	const envOrigin = process.env.WORKER_DEV_ORIGIN
	if (envOrigin) return envOrigin.trim()
	return `http://localhost:${port}`
}

function runBunScript(
	script: string,
	args: Array<string> = [],
	envOverrides: Record<string, string> = {},
	options: { outputFilter?: OutputFilterKey } = {},
): ChildProcess {
	const bun = platform() === 'win32' ? 'bun.exe' : 'bun'
	const child = spawn(bun, ['run', '--silent', script, '--', ...args], {
		stdio: ['inherit', 'pipe', 'pipe'],
		env: { ...process.env, ...envOverrides },
	})

	pipeOutput(child, options.outputFilter)

	child.on('exit', (code, signal) => {
		if (signal) return
		if (code && code !== 0) {
			process.exitCode = code
		}
	})

	return child
}

function pipeOutput(
	child: ChildProcess,
	filterKey: OutputFilterKey = 'default',
) {
	const filters = outputFilters[filterKey]
	if (child.stdout) {
		pipeStream(child.stdout, process.stdout, filters)
	}
	if (child.stderr) {
		pipeStream(child.stderr, process.stderr, filters)
	}
}

function pipeStream(
	source: NodeJS.ReadableStream,
	target: NodeJS.WritableStream,
	filters: Array<RegExp>,
) {
	const rl = readline.createInterface({ input: source })
	rl.on('line', (line) => {
		if (filters.some((filter) => filter.test(line))) {
			return
		}
		target.write(`${line}\n`)
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
	const client = runBunScript(
		'dev:client',
		[],
		{},
		{
			outputFilter: 'client',
		},
	)
	const workerVarArgs = Object.entries(mockEnv).flatMap(([key, value]) => [
		'--var',
		`${key}:${value}`,
	])
	const worker = runBunScript(
		'dev:worker',
		[...extraArgs, ...workerVarArgs],
		{ PORT: String(workerPort), ...mockEnv },
		{ outputFilter: 'worker' },
	)
	devChildren = [client, worker]

	if (announce) {
		console.log(dim('\nRestarted dev servers.'))
		logAppRunning(() => workerOrigin)
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
	const child = runBunScript(
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
	const child = runBunScript(
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
		if (mockCursorProcess && !mockCursorProcess.killed) {
			await stopChild(mockCursorProcess)
			mockCursorProcess = null
		}
		const baseUrl = `http://127.0.0.1:${mockPort}`
		const apiToken = `mock-resend-${randomUUID()}`
		const child = runBunScript(
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
			await attachCursorMock(mockEnvOverrides, mockPort)
			return mockEnvOverrides
		}
		const aiPort = await getPort({
			port: Array.from({ length: 10 }, (_, index) => mockPort + 10 + index),
		})
		const aiBaseUrl = `http://127.0.0.1:${aiPort}`
		const aiApiToken = `mock-ai-${randomUUID()}`
		const aiChild = runBunScript(
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
	await attachCursorMock(mockEnvOverrides, mockPort)

	return mockEnvOverrides
}

async function stopChildren(children: Array<ChildProcess>) {
	await Promise.all(children.map((child) => stopChild(child)))
}

async function stopChild(child: ChildProcess) {
	if (child.killed) return
	child.kill('SIGINT')
	const didExit = await waitForExit(child, 5000)
	if (didExit) return
	child.kill('SIGTERM')
	await waitForExit(child, 2000)
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
	return Promise.race([
		new Promise<boolean>((resolve) => {
			child.once('exit', () => resolve(true))
		}),
		delay(timeoutMs).then(() => false),
	])
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
