import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { jobDeleteCapability } from './job-delete.ts'
import { jobGetCapability } from './job-get.ts'
import { jobListCapability } from './job-list.ts'
import { jobRunNowCapability } from './job-run-now.ts'
import { jobUpsertCapability } from './job-upsert.ts'

export const jobsDomain = defineDomain({
	name: capabilityDomainNames.jobs,
	description:
		'Create, update, inspect, delete, and trigger unified jobs. Jobs support codemode execution, facet-backed Durable Object execution, cron schedules, interval schedules, and one-shot runs.',
	keywords: ['job', 'jobs', 'schedule', 'cron', 'interval', 'run later'],
	capabilities: [
		jobUpsertCapability,
		jobListCapability,
		jobGetCapability,
		jobDeleteCapability,
		jobRunNowCapability,
	],
})
