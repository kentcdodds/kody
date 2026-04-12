import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { schedulerCreateCapability } from './scheduler-create.ts'
import { schedulerDeleteCapability } from './scheduler-delete.ts'
import { schedulerGetCapability } from './scheduler-get.ts'
import { schedulerListCapability } from './scheduler-list.ts'
import { schedulerRunNowCapability } from './scheduler-run-now.ts'
import { schedulerUpdateCapability } from './scheduler-update.ts'

export const schedulerDomain = defineDomain({
	name: capabilityDomainNames.scheduler,
	description:
		'Create, inspect, update, delete, and trigger scheduled codemode jobs that run once at a UTC timestamp or recur on a timezone-aware cron schedule.',
	keywords: ['schedule', 'scheduler', 'cron', 'datetime', 'run later', 'job'],
	capabilities: [
		schedulerCreateCapability,
		schedulerListCapability,
		schedulerGetCapability,
		schedulerUpdateCapability,
		schedulerDeleteCapability,
		schedulerRunNowCapability,
	],
})
