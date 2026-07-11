import { silenceExpectedConsoleWarns } from './console-spies.ts'

// The worker bundler warns that it is experimental, and the registry runtime's
// optional MCP-server, usage, and runtime-debug lookups warn when their tables
// are absent from the unit-test schema. Tests that run those paths swallow
// exactly these messages; any other warning still fails the test so real
// problems are never silently suppressed.
const incidentalRuntimeWarnings = [
	/^\[worker-bundler\] /,
	'mcp-server-refs-load-failed',
	'usage-event-record-failed',
	'usage-event-analytics-failed',
	'usage-rollup-failed',
	'package-runtime-debug-start-failed',
	'package-runtime-debug-logs-failed',
	'package-runtime-debug-status-failed',
	'package-runtime-debug-finish-unhandled',
]

export function silenceIncidentalRuntimeWarnings(
	extraPatterns: Array<RegExp | string> = [],
) {
	silenceExpectedConsoleWarns([...incidentalRuntimeWarnings, ...extraPatterns])
}
