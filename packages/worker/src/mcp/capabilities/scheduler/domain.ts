import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { schedulerDeleteCapability } from './scheduler-delete.ts'
import { schedulerGetCapability } from './scheduler-get.ts'
import { schedulerListCapability } from './scheduler-list.ts'
import { schedulerRunNowCapability } from './scheduler-run-now.ts'
import { schedulerUpsertCapability } from './scheduler-upsert.ts'

export const schedulerDomain = defineDomain({
	name: capabilityDomainNames.scheduler,
	description:
		'Create, upsert, inspect, delete, and trigger scheduled codemode jobs that run once at a UTC timestamp or recur on a timezone-aware cron schedule.',
	keywords: ['schedule', 'scheduler', 'cron', 'datetime', 'run later', 'job'],
	capabilities: [
		schedulerUpsertCapability,
		schedulerListCapability,
		schedulerGetCapability,
		schedulerDeleteCapability,
		schedulerRunNowCapability,
	],
})
