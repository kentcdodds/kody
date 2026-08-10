import { type AdminUsageMetric } from '#universal/loader-data.ts'
import { chartColor } from './chart-theme.ts'

export type UsageMetricSeries = {
	metric: AdminUsageMetric
	label: string
	color: string
}

/**
 * Shared label + color assignment for the metered usage metrics so the
 * admin insights charts and the per-user usage drill-down stay visually
 * consistent.
 */
export const usageMetricSeries: Array<UsageMetricSeries> = [
	{ metric: 'execute', label: 'Executes', color: chartColor.blue },
	{
		metric: 'package_export',
		label: 'Package runs',
		color: chartColor.emerald,
	},
	{
		metric: 'package_static_call',
		label: 'Static package calls',
		color: chartColor.teal,
	},
	{ metric: 'job_run', label: 'Job runs', color: chartColor.amber },
	{ metric: 'workflow_run', label: 'Workflow runs', color: chartColor.violet },
	{
		metric: 'service_runtime',
		label: 'Service runtime',
		color: chartColor.rose,
	},
	{ metric: 'outbound_fetch', label: 'Fetches', color: chartColor.cyan },
	{ metric: 'email_send', label: 'Email sends', color: chartColor.lime },
	{
		metric: 'email_received',
		label: 'Email receives',
		color: chartColor.fuchsia,
	},
]

export const monthShortNames = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
] as const

/** `2026-06` -> `Jun ’26` */
export function formatMonthKeyLabel(monthKey: string) {
	const monthIndex = Number(monthKey.slice(5, 7)) - 1
	return `${monthShortNames[monthIndex] ?? '?'} ’${monthKey.slice(2, 4)}`
}
