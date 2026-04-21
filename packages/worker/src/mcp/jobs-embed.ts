import { type JobView } from '#worker/jobs/types.ts'

const defaultJobEmbedMaxChars = 8_000

export function buildJobEmbedText(
	input: {
		name: string
		description?: string | null
		keywords?: Array<string>
		searchText?: string | null
		scheduleSummary: string
		sourceId?: string | null
		publishedCommit?: string | null
	},
	maxChars: number = defaultJobEmbedMaxChars,
) {
	const text = [
		input.name,
		input.description ?? '',
		...(input.keywords ?? []),
		input.searchText ?? '',
		'job',
		'scheduled task',
		input.scheduleSummary,
		input.sourceId ? `source ${input.sourceId}` : '',
		input.publishedCommit ? `commit ${input.publishedCommit}` : '',
	]
		.filter((value) => value.length > 0)
		.join('\n')
	return text.slice(0, maxChars)
}

export function buildJobUsage(job: Pick<JobView, 'id'>) {
	return `Inspect with job_get: ${JSON.stringify({ id: job.id })}. List jobs with job_list: {}. Trigger immediately with job_run_now: ${JSON.stringify({ id: job.id })}.`
}
