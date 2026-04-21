import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { jobGetCapability } from './job-get.ts'
import { jobListCapability } from './job-list.ts'
import { jobRunNowCapability } from './job-run-now.ts'
import { jobScheduleCapability } from './job-schedule.ts'
import { jobScheduleOnceCapability } from './job-schedule-once.ts'

export const jobsDomain = defineDomain({
	name: capabilityDomainNames.jobs,
	description:
		'Inspect, schedule, or trigger repo-backed jobs. Use this for one-off or recurring jobs without creating a saved package.',
	keywords: [
		'job',
		'schedule',
		'one-off',
		'interval',
		'cron',
		'background',
		'debug',
		'inspect',
		'run now',
		'immediate',
	],
	capabilities: [
		jobListCapability,
		jobGetCapability,
		jobScheduleCapability,
		jobScheduleOnceCapability,
		jobRunNowCapability,
	],
})
