import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { jobScheduleOnceCapability } from './job-schedule-once.ts'

export const jobsDomain = defineDomain({
	name: capabilityDomainNames.jobs,
	description:
		'Schedule repo-backed jobs. Use this for one-off jobs that should run later without creating a saved package.',
	keywords: ['job', 'schedule', 'one-off', 'background', 'delayed'],
	capabilities: [jobScheduleOnceCapability],
})
