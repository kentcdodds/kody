import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	assertIslandRouterConfigured,
	validateIslandRouterFingerprint,
} from './validation.ts'
import {
	type IslandRouterCommandRequest,
	type IslandRouterCommandResult,
} from './types.ts'

type LocalCommandResult = {
	stdout: string
	stderr: string
	exitCode: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
}

type HostVerification = {
	args: Array<string>
	cleanup: () => Promise<void>
}

function onceProcessExit(child: ChildProcess) {
	return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once('error', reject)
			child.once('close', (exitCode, signal) => {
				resolve({
					exitCode,
					signal,
				})
			})
		},
	)
}

async function runLocalCommand(input: {
	command: string
	args: Array<string>
	stdin?: string
	timeoutMs: number
}) {
	const child = spawn(input.command, input.args, {
		stdio: 'pipe',
	})
	let stdout = ''
	let stderr = ''
	child.stdout?.setEncoding('utf8')
	child.stdout?.on('data', (chunk: string | Buffer) => {
		stdout += String(chunk)
	})
	child.stderr?.setEncoding('utf8')
	child.stderr?.on('data', (chunk: string | Buffer) => {
		stderr += String(chunk)
	})
	if (input.stdin) {
		child.stdin?.write(input.stdin)
	}
	child.stdin?.end()

	let timedOut = false
	let closed = false
	child.once('close', () => {
		closed = true
	})
	const timeout = setTimeout(() => {
		timedOut = true
		child.kill('SIGTERM')
		setTimeout(() => {
			if (!closed) {
				child.kill('SIGKILL')
			}
		}, 1000).unref()
	}, input.timeoutMs)

	let result: Awaited<ReturnType<typeof onceProcessExit>>
	try {
		result = await onceProcessExit(child)
	} finally {
		clearTimeout(timeout)
	}

	return {
		stdout,
		stderr,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut,
	} satisfies LocalCommandResult
}

function parseFingerprints(output: string) {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const parts = line.split(/\s+/)
			return parts[1] ?? null
		})
		.filter((value): value is string => Boolean(value))
}

async function createFingerprintVerifiedKnownHosts(input: {
	host: string
	port: number
	expectedFingerprint: string
	timeoutMs: number
}): Promise<HostVerification> {
	const expectedFingerprint = validateIslandRouterFingerprint(
		input.expectedFingerprint,
	)
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-island-router-'))
	const knownHostsPath = path.join(tempDir, 'known_hosts')

	try {
		const keyscan = await runLocalCommand({
			command: 'ssh-keyscan',
			args: ['-p', String(input.port), input.host],
			timeoutMs: input.timeoutMs,
		})
		if (keyscan.timedOut || keyscan.exitCode !== 0 || !keyscan.stdout.trim()) {
			throw new Error(
				`ssh-keyscan failed for ${input.host}:${input.port}. ${keyscan.stderr.trim()}`.trim(),
			)
		}

		await writeFile(knownHostsPath, keyscan.stdout, 'utf8')

		const hashMode = expectedFingerprint.startsWith('MD5:') ? 'md5' : 'sha256'
		const keygen = await runLocalCommand({
			command: 'ssh-keygen',
			args: ['-lf', knownHostsPath, '-E', hashMode],
			timeoutMs: input.timeoutMs,
		})
		if (keygen.timedOut || keygen.exitCode !== 0 || !keygen.stdout.trim()) {
			throw new Error(
				`ssh-keygen failed while validating ${input.host}:${input.port}. ${keygen.stderr.trim()}`.trim(),
			)
		}

		const fingerprints = parseFingerprints(keygen.stdout)
		if (!fingerprints.includes(expectedFingerprint)) {
			throw new Error(
				`Island router host fingerprint mismatch. Expected ${expectedFingerprint}, received ${fingerprints.join(', ') || 'none'}.`,
			)
		}

		return {
			args: [
				'-o',
				'StrictHostKeyChecking=yes',
				'-o',
				`UserKnownHostsFile=${knownHostsPath}`,
				'-o',
				'GlobalKnownHostsFile=/dev/null',
			],
			cleanup: async () => {
				await rm(tempDir, { recursive: true, force: true })
			},
		}
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
		throw error
	}
}

async function resolveHostVerification(
	config: HomeConnectorConfig,
	timeoutMs: number,
): Promise<HostVerification> {
	if (config.islandRouterKnownHostsPath) {
		await stat(config.islandRouterKnownHostsPath)
		return {
			args: [
				'-o',
				'StrictHostKeyChecking=yes',
				'-o',
				`UserKnownHostsFile=${config.islandRouterKnownHostsPath}`,
				'-o',
				'GlobalKnownHostsFile=/dev/null',
			],
			cleanup: async () => {},
		}
	}

	if (config.islandRouterHostFingerprint && config.islandRouterHost) {
		return await createFingerprintVerifiedKnownHosts({
			host: config.islandRouterHost,
			port: config.islandRouterPort,
			expectedFingerprint: config.islandRouterHostFingerprint,
			timeoutMs,
		})
	}

	return {
		args: [],
		cleanup: async () => {},
	}
}

function createSshArgs(config: HomeConnectorConfig, verificationArgs: Array<string>) {
	return [
		'-T',
		'-p',
		String(config.islandRouterPort),
		'-i',
		config.islandRouterPrivateKeyPath ?? '',
		'-o',
		'BatchMode=yes',
		'-o',
		'IdentitiesOnly=yes',
		'-o',
		'PreferredAuthentications=publickey',
		'-o',
		'LogLevel=ERROR',
		...verificationArgs,
		`${config.islandRouterUsername}@${config.islandRouterHost}`,
	]
}

function assertSingleCliLine(value: string, field: string) {
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw new Error(`${field} must not be empty.`)
	}
	if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
		throw new Error(`${field} must not contain control characters.`)
	}
	return trimmed
}

function escapeCliQuery(value: string) {
	return assertSingleCliLine(value, 'query')
		.replaceAll('\\', '\\\\')
		.replaceAll('"', '\\"')
}

function getCommandLines(request: IslandRouterCommandRequest): Array<string> {
	switch (request.id) {
		case 'show-version':
			return ['show version']
		case 'show-clock':
			return ['show clock']
		case 'show-interface-summary':
			return ['show interface summary']
		case 'show-interface':
			return [
				`show interface ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
			]
		case 'show-ip-interface':
			return [
				`show ip interface ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
			]
		case 'show-ip-neighbors':
			return ['show ip neighbors']
		case 'show-ip-dhcp-reservations':
			return ['show ip dhcp-reservations']
		case 'show-log':
			return request.query
				? [`show log last where "${escapeCliQuery(request.query)}"`]
				: ['show log last']
		case 'ping':
			return [`ping ${assertSingleCliLine(request.host, 'host')}`]
		default: {
			const _exhaustive: never = request
			throw new Error(`Unhandled Island router command request: ${String(_exhaustive)}`)
		}
	}
}

function writeCommandLines(child: ChildProcess, commandLines: Array<string>) {
	for (const line of commandLines) {
		child.stdin?.write(`${line}\n`)
	}
}

export function createIslandRouterSshCommandRunner(config: HomeConnectorConfig) {
	assertIslandRouterConfigured(config)
	let verificationPromise: Promise<HostVerification> | null = null
	let cleanupRegistered = false

	async function getVerification() {
		if (!verificationPromise) {
			verificationPromise = resolveHostVerification(
				config,
				config.islandRouterCommandTimeoutMs,
			)
				.then((verification) => {
					if (!cleanupRegistered) {
						cleanupRegistered = true
						process.once('exit', () => {
							void verification.cleanup().catch(() => {})
						})
					}
					return verification
				})
				.catch((error) => {
					verificationPromise = null
					throw error
				})
		}
		return await verificationPromise
	}

	return async (
		request: IslandRouterCommandRequest,
	): Promise<IslandRouterCommandResult> => {
		const timeoutMs =
			request.timeoutMs == null
				? config.islandRouterCommandTimeoutMs
				: request.timeoutMs
		const verification = await getVerification()
		const commandLines = ['terminal length 0', ...getCommandLines(request)]
		const start = Date.now()

		const child = spawn('ssh', createSshArgs(config, verification.args), {
			stdio: 'pipe',
		})

		let stdout = ''
		let stderr = ''
		child.stdout?.setEncoding('utf8')
		child.stdout?.on('data', (chunk: string | Buffer) => {
			stdout += String(chunk)
		})
		child.stderr?.setEncoding('utf8')
		child.stderr?.on('data', (chunk: string | Buffer) => {
			stderr += String(chunk)
		})

		writeCommandLines(child, commandLines)

		let timedOut = false
		let closed = false
		child.once('close', () => {
			closed = true
		})
		let timeout: NodeJS.Timeout | null = null
		if (request.id === 'ping' && request.allowTimeout) {
			timeout = setTimeout(() => {
				timedOut = true
				child.stdin?.write('\u0003')
				child.stdin?.write('\nexit\n')
				child.stdin?.end()
				setTimeout(() => {
					if (closed) return
					child.kill('SIGTERM')
					setTimeout(() => {
						if (!closed) {
							child.kill('SIGKILL')
						}
					}, 1000).unref()
				}, 1000).unref()
			}, timeoutMs)
		} else {
			child.stdin?.write('exit\n')
			child.stdin?.end()
			timeout = setTimeout(() => {
				timedOut = true
				child.kill('SIGTERM')
				setTimeout(() => {
					if (!closed) {
						child.kill('SIGKILL')
					}
				}, 1000).unref()
			}, timeoutMs)
		}

		let result: Awaited<ReturnType<typeof onceProcessExit>>
		try {
			result = await onceProcessExit(child)
		} finally {
			if (timeout) clearTimeout(timeout)
		}

		return {
			id: request.id,
			commandLines,
			stdout,
			stderr,
			exitCode: result.exitCode,
			signal: result.signal,
			timedOut,
			durationMs: Date.now() - start,
		}
	}
}
