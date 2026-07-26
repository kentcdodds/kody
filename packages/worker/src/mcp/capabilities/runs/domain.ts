import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { runGetCapability } from './run-get.ts'
import { runListCapability } from './run-list.ts'
import { runSummaryCapability } from './run-summary.ts'

export const runsDomain = defineDomain({
	name: capabilityDomainNames.runs,
	description:
		'User-level execution history across jobs, webhooks, package apps, services, workflows, execute failures, and other runtimes for debugging failures and answering why something stopped working.',
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
	],
	capabilities: [runListCapability, runGetCapability, runSummaryCapability],
})
