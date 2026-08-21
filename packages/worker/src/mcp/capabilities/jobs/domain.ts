import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { jobDeleteCapability } from './job-delete.ts'
import { jobGetCapability } from './job-get.ts'
import { jobListCapability } from './job-list.ts'
import { jobRunNowCapability } from './job-run-now.ts'
import { jobUpdateCapability } from './job-update.ts'
import { workflowCancelCapability } from './workflow-cancel.ts'
import { workflowListCapability } from './workflow-list.ts'

export const jobsDomain = defineDomain({
	name: capabilityDomainNames.jobs,
	description:
		'Inspect, update metadata, or trigger package-owned jobs, and list or cancel workflow runs.',
	keywords: [
		'job',
		'schedule',
		'interval',
		'cron',
		'update',
		'delete',
		'disable',
		'enable',
		'background',
		'debug',
		'inspect',
		'run now',
		'immediate',
		'cancel',
		'stop',
		'workflow',
	],
	capabilities: [
		jobListCapability,
		jobGetCapability,
		jobUpdateCapability,
		jobDeleteCapability,
		jobRunNowCapability,
		workflowListCapability,
		workflowCancelCapability,
	],
})
