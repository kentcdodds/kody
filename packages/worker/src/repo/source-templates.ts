import { type JobView } from '#worker/jobs/types.ts'

function stringifyManifest(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`
}

export function buildJobSourceFiles(input: {
	job: Pick<JobView, 'name' | 'scheduleSummary'>
	moduleSource?: string | null
}) {
	const manifest = {
		version: 1 as const,
		kind: 'job' as const,
		title: input.job.name,
		description: input.job.scheduleSummary,
		keywords: ['job', 'scheduled'],
		searchText: input.job.scheduleSummary,
		sourceRoot: '/',
		entrypoint: 'src/job.ts',
	}
	const files: Record<string, string> = {
		'kody.json': stringifyManifest(manifest),
	}
	if (input.moduleSource != null) {
		files['src/job.ts'] = `${input.moduleSource.trim()}\n`
	}
	return files
}
