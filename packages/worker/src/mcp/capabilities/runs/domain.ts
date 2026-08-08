import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { runGetCapability } from './run-get.ts'
import { runListCapability } from './run-list.ts'
import { runSummaryCapability } from './run-summary.ts'
import { runUpdateBulkCapability } from './run-update-bulk.ts'
import { runUpdateCapability } from './run-update.ts'

export const runsDomain = defineDomain({
	name: capabilityDomainNames.runs,
	description:
		'User-level execution history for debugging failed runtimes, including soft triage (ignore/resolve) for retained errors.',
	keywords: [
		'runs',
		'history',
		'logs',
		'debug',
		'failures',
		'errors',
		'crashes',
		'observability',
		'jobs',
		'webhooks',
		'package apps',
		'ignored',
		'resolved',
		'triage',
	],
	capabilities: [
		runListCapability,
		runGetCapability,
		runSummaryCapability,
		runUpdateCapability,
		runUpdateBulkCapability,
	],
})
