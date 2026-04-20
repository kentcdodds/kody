import { type AuthoredPackageJson, type PackageJobDefinition } from './types.ts'

function formatJobSchedule(job: PackageJobDefinition) {
	if (job.schedule.type === 'cron') {
		return `cron ${job.schedule.expression}`
	}
	if (job.schedule.type === 'interval') {
		return `interval ${job.schedule.every}`
	}
	return `once ${job.schedule.runAt}`
}

export function buildSavedPackageEmbedText(manifest: AuthoredPackageJson) {
	const tags = manifest.kody.tags ?? []
	const exportLines = Object.entries(manifest.exports).map(
		([exportName, target]) =>
			`${exportName} ${
				typeof target === 'string'
					? target
					: [target.import, target.default, target.types]
							.filter((value): value is string => Boolean(value))
							.join(' ')
			}`.trim(),
	)
	const jobLines = Object.entries(manifest.kody.jobs ?? {}).map(
		([jobName, job]) =>
			`${jobName} ${job.entry} ${formatJobSchedule(job)}`.trim(),
	)
	return [
		`package ${manifest.kody.id}`,
		manifest.name,
		manifest.kody.description,
		tags.join(' '),
		manifest.kody.searchText ?? '',
		exportLines.join('\n'),
		jobLines.join('\n'),
		manifest.kody.app ? `app ${manifest.kody.app.entry}` : '',
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}
