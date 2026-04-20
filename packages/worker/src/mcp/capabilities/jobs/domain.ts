import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { jobRunNowCapability } from './job-run-now.ts'
import { jobScheduleCapability } from './job-schedule.ts'
import { jobScheduleOnceCapability } from './job-schedule-once.ts'

export const jobsDomain = defineDomain({
	name: capabilityDomainNames.jobs,
	description:
		'Schedule repo-backed jobs or trigger an existing job immediately. Use this for one-off or recurring jobs without creating a saved package.',
	keywords: [
		'job',
		'schedule',
		'one-off',
		'interval',
		'cron',
		'background',
		'run now',
		'immediate',
	],
	capabilities: [
		jobScheduleCapability,
		jobScheduleOnceCapability,
		jobRunNowCapability,
	],
})
