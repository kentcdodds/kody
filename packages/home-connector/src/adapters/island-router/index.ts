import { type HomeConnectorConfig } from '../../config.ts'
import {
	type IslandRouterCommandRequest,
	type IslandRouterCommandResult,
	type IslandRouterCommandRunner,
	type IslandRouterCommandId,
	type IslandRouterRunCommandResult,
	type IslandRouterStatus,
	islandRouterCommandConfirmation,
} from './types.ts'
import {
	getIslandRouterCommandCatalogEntry,
	renderIslandRouterCommand,
} from './command-catalog.ts'
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
	getIslandRouterConfigStatus,
} from './validation.ts'

type RunCommandRequest = {
	commandId: IslandRouterCommandId
	params?: Record<string, unknown>
	query?: string
	limit?: number
	timeoutMs?: number
	reason?: string
	confirmation?: string
}

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

function hasRequestedLineFilter(input: { query?: string; limit?: number }) {
	return (input.query?.trim().length ?? 0) > 0 || input.limit != null
}

function assertSupportedLineFilter(input: {
	commandId: IslandRouterCommandId
	supportsLineFilter?: true
	query?: string
	limit?: number
}) {
	if (input.supportsLineFilter || !hasRequestedLineFilter(input)) return
	throw new Error(
		`Island router command ${input.commandId} does not support query/limit filtering.`,
	)
}

function assertWriteSafety(input: {
	config: HomeConnectorConfig
	commandId: IslandRouterCommandId
	reason?: string
	confirmation?: string
}) {
	const status = assertIslandRouterConfigured(input.config)
	if (status.verificationMode === 'none') {
		throw new Error(
			'Island router write commands require SSH host verification. Set ISLAND_ROUTER_KNOWN_HOSTS_PATH or ISLAND_ROUTER_HOST_FINGERPRINT before using them.',
		)
	}
	if (!status.writeCapabilitiesAvailable) {
		const details = status.writeWarnings.filter(Boolean).join(' ')
		throw new Error(
			`Island router write commands are unavailable. ${details}`.trim(),
		)
	}
	const reason = input.reason?.trim() ?? ''
	if (reason.length < 20) {
		throw new Error(
			`Island router command ${input.commandId} requires a specific operator reason of at least 20 characters.`,
		)
	}
	if ((input.confirmation ?? '').trim() !== islandRouterCommandConfirmation) {
		throw new Error(
			`Island router command ${input.commandId} requires the exact confirmation: "${islandRouterCommandConfirmation}"`,
		)
	}
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
		writeConfirmation: islandRouterCommandConfirmation,
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
						id: 'show version',
						timeoutMs,
					}),
					runner({
						id: 'show clock',
						timeoutMs,
					}),
					runner({
						id: 'show interface summary',
						timeoutMs,
					}),
					runner({
						id: 'show ip neighbors',
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
		async runCommand(
			request: RunCommandRequest,
		): Promise<IslandRouterRunCommandResult> {
			const catalogEntry = getIslandRouterCommandCatalogEntry(request.commandId)
			const timeoutMs = normalizeTimeoutMs(config, request.timeoutMs)
			assertIslandRouterConfigured(config)
			if (catalogEntry.access === 'write') {
				assertWriteSafety({
					config,
					commandId: request.commandId,
					reason: request.reason,
					confirmation: request.confirmation,
				})
			}
			assertSupportedLineFilter({
				commandId: request.commandId,
				supportsLineFilter: catalogEntry.supportsLineFilter,
				query: request.query,
				limit: request.limit,
			})
			const rendered = renderIslandRouterCommand({
				id: request.commandId,
				params: request.params,
			})
			const commandRequest = {
				id: request.commandId,
				params:
					Object.keys(rendered.normalizedParams).length === 0
						? undefined
						: rendered.normalizedParams,
				timeoutMs,
			} satisfies IslandRouterCommandRequest
			const result = ensureSuccessfulCommand(
				await getRunner()(commandRequest),
				`Island router command ${request.commandId}`,
			)
			const rawOutput = parseIslandRouterRawOutput(
				result.stdout,
				result.commandLines,
			).rawOutput
			const lines = rawOutput.length === 0 ? [] : rawOutput.split('\n')
			const filteredLines =
				catalogEntry.supportsLineFilter
					? filterCommandLines({
							lines,
							query: request.query,
							limit: request.limit,
						})
					: lines
			return {
				commandId: result.id,
				catalogEntry,
				params: rendered.normalizedParams,
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
	}
}
