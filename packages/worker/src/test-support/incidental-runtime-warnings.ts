import { silenceExpectedConsoleWarns } from './console-spies.ts'

// The worker bundler warns that it is experimental, and the registry runtime's
// optional MCP-server, usage, run-record, and activation lookups warn when
// their tables or bindings are absent from the unit-test schema. Tests that run
// those paths swallow exactly these messages; any other warning still fails the
// test so real problems are never silently suppressed.
const incidentalRuntimeWarnings = [
	/^\[worker-bundler\] /,
	'mcp-server-refs-load-failed',
	'usage-event-record-failed',
	'usage-event-analytics-failed',
	'usage-rollup-failed',
	'run-record-begin-failed',
	'run-record-start-failed',
	'run-record-finish-failed',
	'activation-milestone-failed',
	'activation-run-record-failed',
]

export function silenceIncidentalRuntimeWarnings(
	extraPatterns: Array<RegExp | string> = [],
) {
	silenceExpectedConsoleWarns([...incidentalRuntimeWarnings, ...extraPatterns])
}
