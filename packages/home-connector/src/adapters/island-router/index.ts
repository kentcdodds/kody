import { type HomeConnectorConfig } from '../../config.ts'
import {
	type IslandRouterCommandRequest,
	type IslandRouterCommandResult,
	type IslandRouterCommandRunner,
	type IslandRouterReadCommand,
	type IslandRouterReadCommandCatalogEntry,
	type IslandRouterReadCommandResult,
	type IslandRouterStatus,
	type IslandRouterWriteOperation,
	type IslandRouterWriteOperationId,
	type IslandRouterWriteOperationResult,
	islandRouterReadCommandCatalog,
	islandRouterWriteOperationCatalog,
} from './types.ts'
import { createIslandRouterSshCommandRunner } from './ssh-client.ts'
import {
	didIslandRouterCommandSucceed,
	parseIslandRouterClock,
	parseIslandRouterInterfaceSummaries,
	parseIslandRouterNeighbors,
	parseIslandRouterRawOutput,
	parseIslandRouterVersion,
} from './parsing.ts'
import {
	assertIslandRouterConfigured,
	assertIslandRouterWriteConfigured,
	getIslandRouterConfigStatus,
} from './validation.ts'

type WriteOperationRequest = {
	timeoutMs?: number
	acknowledgeHighRisk: boolean
	reason: string
	confirmation: string
}

type RunReadCommandRequest = {
	command: IslandRouterReadCommand
	interfaceName?: string
	query?: string
	limit?: number
	timeoutMs?: number
}

type RunWriteOperationRequest = WriteOperationRequest & {
	operation: IslandRouterWriteOperation
}

const islandRouterWriteAcknowledgements = {
	runWriteOperation:
		'I am highly certain running this guarded Island router write operation is necessary right now.',
} as const

function normalizeLimit(value: number | undefined, fallback: number, max: number) {
	if (value == null || !Number.isFinite(value)) return fallback
	return Math.max(1, Math.min(max, Math.trunc(value)))
}

function normalizeTimeoutMs(config: HomeConnectorConfig, timeoutMs?: number) {
	if (timeoutMs == null || !Number.isFinite(timeoutMs)) {
		return config.islandRouterCommandTimeoutMs
	}
	return Math.max(1000, Math.trunc(timeoutMs))
}

function assertNonEmpty(value: string, field: string) {
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw new Error(`${field} must not be empty.`)
	}
	return trimmed
}

function normalizeInterfaceName(value: string) {
	return assertNonEmpty(value, 'interfaceName')
}

function ensureSuccessfulCommand(
	result: IslandRouterCommandResult,
	message: string,
) {
	if (result.timedOut) {
		throw new Error(`${message} timed out after ${result.durationMs}ms.`)
	}
	if (result.exitCode === null) {
		const reason = result.signal
			? `signal ${result.signal}`
			: 'an unknown termination state'
		throw new Error(
			`${message} failed because the command exited via ${reason}. ${result.stderr.trim()}`.trim(),
		)
	}
	if (!didIslandRouterCommandSucceed(result)) {
		throw new Error(
			`${message} failed with exit code ${result.exitCode}. ${result.stderr.trim()}`.trim(),
		)
	}
	return result
}

function assertWriteAcknowledgement(
	received: string,
	expected: string,
	operationLabel: string,
) {
	if (received.trim() !== expected) {
		throw new Error(
			`${operationLabel} requires the exact acknowledgement: "${expected}"`,
		)
	}
}

function assertWriteReason(reason: string, operationLabel: string) {
	const trimmed = reason.trim()
	if (trimmed.length < 20) {
		throw new Error(
			`${operationLabel} requires a specific operator reason of at least 20 characters.`,
		)
	}
}

function getReadCommandCatalogEntry(command: IslandRouterReadCommand) {
	const entry = islandRouterReadCommandCatalog.find(
		(candidate) => candidate.command === command,
	)
	if (!entry) {
		throw new Error(`Unsupported Island router read command: ${command}`)
	}
	return entry
}

function getWriteOperationCatalogEntry(operation: IslandRouterWriteOperation) {
	const entry = islandRouterWriteOperationCatalog.find(
		(candidate) => candidate.operation === operation,
	)
	if (!entry) {
		throw new Error(`Unsupported Island router write operation: ${operation}`)
	}
	return entry
}

function filterCommandLines(input: {
	lines: Array<string>
	query?: string
	limit?: number
}) {
	const normalizedQuery = input.query?.trim().toLowerCase() ?? ''
	const filtered =
		normalizedQuery.length === 0
			? input.lines
			: input.lines.filter((line) =>
					line.toLowerCase().includes(normalizedQuery),
				)
	const limit = normalizeLimit(input.limit, filtered.length, 10_000)
	return filtered.slice(0, limit)
}

async function runHighRiskCommand(input: {
	config: HomeConnectorConfig
	runner: IslandRouterCommandRunner
	timeoutMs?: number
	operationId: IslandRouterWriteOperationId
	commandRequest: IslandRouterCommandRequest
	message: string
	acknowledgeHighRisk: boolean
	reason: string
	confirmation: string
	expectedAcknowledgement: string
}) {
	assertIslandRouterWriteConfigured(input.config)
	if (!input.acknowledgeHighRisk) {
		throw new Error(
			`${input.message} requires acknowledgeHighRisk=true because this is a high-risk mutating router operation.`,
		)
	}
	assertWriteReason(input.reason, input.message)
	assertWriteAcknowledgement(
		input.confirmation,
		input.expectedAcknowledgement,
		input.message,
	)
	const timeoutMs = normalizeTimeoutMs(input.config, input.timeoutMs)
	const commandRequest = {
		...input.commandRequest,
		timeoutMs,
	} as IslandRouterCommandRequest
	const result = ensureSuccessfulCommand(
		await input.runner(commandRequest),
		input.message,
	)
	return {
		operationId: input.operationId,
		commandId:
			result.id as IslandRouterWriteOperationResult['commandId'],
		commandLines: result.commandLines,
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
	} satisfies IslandRouterWriteOperationResult
}

export function createIslandRouterAdapter(input: {
	config: HomeConnectorConfig
	commandRunner?: IslandRouterCommandRunner
}) {
	const { config } = input
	let cachedRunner: IslandRouterCommandRunner | null = null

	function getRunner() {
		if (input.commandRunner) return input.commandRunner
		cachedRunner ??= createIslandRouterSshCommandRunner(config)
		return cachedRunner
	}

	function getConfigStatus() {
		return getIslandRouterConfigStatus(config)
	}

	return {
		getConfigStatus,
		writeAcknowledgements: islandRouterWriteAcknowledgements,
		async getStatus(): Promise<IslandRouterStatus> {
			const configStatus = getConfigStatus()
			if (!configStatus.configured) {
				const missingReasons = [
					...configStatus.missingFields,
					...configStatus.warnings,
				].filter(Boolean)
				return {
					config: configStatus,
					connected: false,
					router: {
						version: null,
						clock: null,
					},
					interfaces: [],
					neighbors: [],
					errors: [
						`Island router diagnostics are not configured: ${missingReasons.join(', ')}.`,
					],
				}
			}

			assertIslandRouterConfigured(config)
			const runner = getRunner()
			const timeoutMs = normalizeTimeoutMs(config)
			const errors: Array<string> = []

			const [versionResult, clockResult, interfaceResult, neighborResult] =
				await Promise.all([
					runner({
						id: 'show-version',
						timeoutMs,
					}),
					runner({
						id: 'show-clock',
						timeoutMs,
					}),
					runner({
						id: 'show-interface-summary',
						timeoutMs,
					}),
					runner({
						id: 'show-ip-neighbors',
						timeoutMs,
					}),
				])

			let version = null
			if (didIslandRouterCommandSucceed(versionResult)) {
				version = parseIslandRouterVersion(
					versionResult.stdout,
					versionResult.commandLines,
				)
			} else {
				errors.push('Failed to load Island router version information.')
			}

			let clock = null
			if (didIslandRouterCommandSucceed(clockResult)) {
				clock = parseIslandRouterClock(
					clockResult.stdout,
					clockResult.commandLines,
				)
			} else {
				errors.push('Failed to load Island router clock information.')
			}

			const interfaces = didIslandRouterCommandSucceed(interfaceResult)
				? parseIslandRouterInterfaceSummaries(
						interfaceResult.stdout,
						interfaceResult.commandLines,
					)
				: []
			if (interfaces.length === 0) {
				errors.push('No Island router interface summary data was returned.')
			}

			const neighbors = didIslandRouterCommandSucceed(neighborResult)
				? parseIslandRouterNeighbors(
						neighborResult.stdout,
						neighborResult.commandLines,
					)
				: []
			if (!didIslandRouterCommandSucceed(neighborResult)) {
				errors.push('Failed to load Island router neighbor cache.')
			}

			return {
				config: configStatus,
				connected:
					didIslandRouterCommandSucceed(versionResult) &&
					didIslandRouterCommandSucceed(clockResult) &&
					didIslandRouterCommandSucceed(interfaceResult) &&
					didIslandRouterCommandSucceed(neighborResult),
				router: {
					version,
					clock,
				},
				interfaces,
				neighbors,
				errors,
			}
		},
		async runReadCommand(
			request: RunReadCommandRequest,
		): Promise<IslandRouterReadCommandResult> {
			const catalogEntry = getReadCommandCatalogEntry(request.command)
			const timeoutMs = normalizeTimeoutMs(config, request.timeoutMs)
			let commandRequest: IslandRouterCommandRequest
			switch (request.command) {
				case 'show ip neighbors':
					commandRequest = { id: 'show-ip-neighbors', timeoutMs }
					break
				case 'show ip sockets':
					commandRequest = { id: 'show-ip-sockets', timeoutMs }
					break
				case 'show stats':
					commandRequest = { id: 'show-stats', timeoutMs }
					break
				case 'show interface <iface>':
					commandRequest = {
						id: 'show-interface',
						interfaceName: normalizeInterfaceName(
							assertNonEmpty(request.interfaceName ?? '', 'interfaceName'),
						),
						timeoutMs,
					}
					break
				case 'show ip interface <iface>':
					commandRequest = {
						id: 'show-ip-interface',
						interfaceName: normalizeInterfaceName(
							assertNonEmpty(request.interfaceName ?? '', 'interfaceName'),
						),
						timeoutMs,
					}
					break
				case 'show log':
					commandRequest = { id: 'show-log', timeoutMs }
					break
				case 'show running-config':
					commandRequest = { id: 'show-running-config', timeoutMs }
					break
				case 'show running-config differences':
					commandRequest = {
						id: 'show-running-config-differences',
						timeoutMs,
					}
					break
				case 'show ip dhcp':
					commandRequest = { id: 'show-ip-dhcp', timeoutMs }
					break
				case 'show ip routes':
					commandRequest = { id: 'show-ip-routes', timeoutMs }
					break
				case 'show ip recommendations':
					commandRequest = { id: 'show-ip-recommendations', timeoutMs }
					break
				default: {
					const _exhaustive: never = request.command
					throw new Error(
						`Unhandled Island router read command: ${String(_exhaustive)}`,
					)
				}
			}
			const result = ensureSuccessfulCommand(
				await getRunner()(commandRequest),
				`Island router read command ${request.command}`,
			)
			const rawOutput = parseIslandRouterRawOutput(
				result.stdout,
				result.commandLines,
			).rawOutput
			const lines = rawOutput.length === 0 ? [] : rawOutput.split('\n')
			const filteredLines =
				request.command === 'show log'
					? filterCommandLines({
							lines,
							query: request.query,
							limit: request.limit,
						})
					: lines
			return {
				command: request.command,
				commandId: result.id as IslandRouterReadCommandResult['commandId'],
				catalogEntry,
				commandLines: result.commandLines,
				rawOutput,
				filteredOutput: filteredLines.join('\n'),
				lines: filteredLines,
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				durationMs: result.durationMs,
			}
		},
		async runWriteOperation(request: RunWriteOperationRequest) {
			const catalogEntry = getWriteOperationCatalogEntry(request.operation)
			let operationId: IslandRouterWriteOperationId
			let commandRequest: IslandRouterCommandRequest
			switch (request.operation) {
				case 'renew dhcp clients':
					operationId = 'renew-dhcp-clients'
					commandRequest = { id: 'clear-dhcp-client' }
					break
				case 'clear log buffer':
					operationId = 'clear-log-buffer'
					commandRequest = { id: 'clear-log' }
					break
				case 'save running config':
					operationId = 'save-running-config'
					commandRequest = { id: 'write-memory' }
					break
				default: {
					const _exhaustive: never = request.operation
					throw new Error(
						`Unhandled Island router write operation: ${String(_exhaustive)}`,
					)
				}
			}
			return {
				catalogEntry,
				...(await runHighRiskCommand({
					config,
					runner: getRunner(),
					timeoutMs: request.timeoutMs,
					operationId,
					commandRequest,
					message: `Island router write operation ${request.operation}`,
					acknowledgeHighRisk: request.acknowledgeHighRisk,
					reason: request.reason,
					confirmation: request.confirmation,
					expectedAcknowledgement:
						islandRouterWriteAcknowledgements.runWriteOperation,
				})),
			}
		},
	}
}
