import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	assertIslandRouterConfigured,
	validateIslandRouterFingerprint,
} from './validation.ts'
import { isSuccessfulIslandRouterCliSession } from './parsing.ts'
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
	return new Promise<{
		exitCode: number | null
		signal: NodeJS.Signals | null
	}>((resolve, reject) => {
		child.once('error', reject)
		child.once('close', (exitCode, signal) => {
			resolve({
				exitCode,
				signal,
			})
		})
	})
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
		args: [
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			'-o',
			'GlobalKnownHostsFile=/dev/null',
		],
		cleanup: async () => {},
	}
}

function createSshArgs(
	config: HomeConnectorConfig,
	verificationArgs: Array<string>,
) {
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

function escapeCliValue(value: string, field: string) {
	return assertSingleCliLine(value, field)
		.replaceAll('\\', '\\\\')
		.replaceAll('"', '\\"')
}

function getCommandLines(request: IslandRouterCommandRequest): Array<string> {
	switch (request.id) {
		case 'show-version':
			return ['show version']
		case 'show-clock':
			return ['show clock']
		case 'show-system':
			return ['show system']
		case 'show-interface-summary':
			return ['show interface summary']
		case 'show-interface-statistics':
			return ['show interface statistics']
		case 'show-bandwidth-usage':
			// Best-effort guess; public docs were not found for realtime bandwidth usage.
			return ['show bandwidth-usage']
		case 'show-wan':
			// Best-effort guess; public docs were not found for WAN summary inspection.
			return ['show wan']
		case 'show-wan-failover':
			// Best-effort guess; public docs were not found for WAN failover status.
			return ['show wan failover']
		case 'show-multi-wan':
			// Best-effort guess; public docs were not found for multi-WAN state.
			return ['show multi-wan']
		case 'show-interface':
			return [
				`show interface ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
			]
		case 'show-ip-interface':
			return [
				`show ip interface ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
			]
		case 'show-ip-routes':
			return ['show ip routes']
		case 'show-nat':
			// Best-effort guess; public docs were not found for NAT inspection.
			return ['show nat']
		case 'show-ip-nat':
			// Best-effort guess; public docs were not found for IP NAT inspection.
			return ['show ip nat']
		case 'show-sessions':
			// Best-effort guess; public docs were not found for session table inspection.
			return ['show sessions']
		case 'show-vlan':
			// Best-effort guess; public docs were not found for VLAN inspection.
			return ['show vlan']
		case 'show-dns':
			// Best-effort guess; public docs were not found for DNS inspection.
			return ['show dns']
		case 'show-ip-dns':
			// Best-effort guess; public docs were not found for IP DNS inspection.
			return ['show ip dns']
		case 'show-users':
			return ['show users']
		case 'show-user':
			// Best-effort guess; public docs were not found for per-user detail output.
			return ['show user']
		case 'show-security-policy':
			// Best-effort guess; public docs were not found for security policy inspection.
			return ['show security-policy']
		case 'show-protection':
			// Best-effort guess; public docs were not found for protection inspection.
			return ['show protection']
		case 'show-firewall':
			// Best-effort guess; public docs were not found for firewall inspection.
			return ['show firewall']
		case 'show-qos':
			// Best-effort guess; public docs were not found for QoS inspection.
			return ['show qos']
		case 'show-traffic-policy':
			// Best-effort guess; public docs were not found for traffic policy inspection.
			return ['show traffic-policy']
		case 'show-vpn':
			// Best-effort guess; public docs were not found for VPN inspection.
			return ['show vpn']
		case 'show-ipsec':
			// Best-effort guess; public docs were not found for IPsec inspection.
			return ['show ipsec']
		case 'show-gre':
			// Best-effort guess; public docs were not found for GRE inspection.
			return ['show gre']
		case 'show-ip-neighbors':
			return ['show ip neighbors']
		case 'show-ip-dhcp-reservations':
			return ['show ip dhcp-reservations']
		case 'show-dhcp-server':
			// Best-effort guess; public docs were not found for DHCP server inspection.
			return ['show dhcp-server']
		case 'show-ntp':
			// Best-effort guess; public docs were not found for NTP inspection.
			return ['show ntp']
		case 'show-syslog':
			// Best-effort guess; public docs were not found for syslog inspection.
			return ['show syslog']
		case 'show-snmp':
			// Best-effort guess; public docs were not found for SNMP inspection.
			return ['show snmp']
		case 'show-log':
			return request.query
				? [`show log last where "${escapeCliQuery(request.query)}"`]
				: ['show log last']
		case 'ping':
			return [`ping ${assertSingleCliLine(request.host, 'host')}`]
		case 'force-wan-failover':
			// Best-effort guess; public docs only confirmed priority-based WAN selection,
			// not an explicit "force now" command.
			return [
				`wan failover force ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
			]
		case 'set-dhcp-reservation': {
			const command = [
				'dhcp-server reservation',
				assertSingleCliLine(request.macAddress, 'macAddress'),
				assertSingleCliLine(request.ipAddress, 'ipAddress'),
			]
			if (request.hostName) {
				command.push(`host-name "${escapeCliValue(request.hostName, 'hostName')}"`)
			}
			if (request.interfaceName) {
				command.push(
					`interface ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
				)
			}
			return [command.join(' ')]
		}
		case 'remove-dhcp-reservation':
			return [
				request.ipAddress
					? `no dhcp-server reservation ${assertSingleCliLine(request.macAddress, 'macAddress')} ${assertSingleCliLine(request.ipAddress, 'ipAddress')}`
					: `no dhcp-server reservation ${assertSingleCliLine(request.macAddress, 'macAddress')}`,
			]
		case 'reboot':
			return ['reload']
		case 'set-interface-description':
			return [
				`interface ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
				`description "${escapeCliValue(request.description, 'description')}"`,
			]
		case 'set-dns-server':
			return request.interfaceName
				? [
						`interface ${assertSingleCliLine(request.interfaceName, 'interfaceName')}`,
						...request.servers.map(
							(server) =>
								`ip name-server ${assertSingleCliLine(server, 'servers')}`,
						),
					]
				: request.servers.map(
						(server) =>
							`ip dns server ${assertSingleCliLine(server, 'servers')}`,
					)
		case 'block-host':
			return [
				`firewall block-host ${assertSingleCliLine(request.host, 'host')}`,
			]
		case 'unblock-host':
			return [
				`no firewall block-host ${assertSingleCliLine(request.host, 'host')}`,
			]
		case 'clear-dhcp-client':
			return ['clear dhcp-client']
		case 'clear-log':
			return ['clear log']
		case 'write-memory':
			return ['write memory']
		default: {
			const _exhaustive: never = request
			throw new Error(
				`Unhandled Island router command request: ${String(_exhaustive)}`,
			)
		}
	}
}

function writeCommandLines(child: ChildProcess, commandLines: Array<string>) {
	for (const line of commandLines) {
		child.stdin?.write(`${line}\n`)
	}
}

export function createIslandRouterSshCommandRunner(
	config: HomeConnectorConfig,
) {
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
			exitCode: isSuccessfulIslandRouterCliSession({
				stdout,
				stderr,
				commandLines,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut,
			})
				? 0
				: result.exitCode,
			signal: result.signal,
			timedOut,
			durationMs: Date.now() - start,
		}
	}
}
