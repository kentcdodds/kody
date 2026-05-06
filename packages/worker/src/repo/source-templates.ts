import { type UiArtifactParameterInput } from '@kody-internal/shared/ui-artifact-parameters.ts'
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

export function buildAppSourceFiles(input: {
	title: string
	description: string
	parameters?: Array<UiArtifactParameterInput> | null
	hidden: boolean
	clientCode: string | null
	serverCode: string | null
}) {
	const manifest = {
		version: 1 as const,
		kind: 'app' as const,
		title: input.title,
		description: input.description,
		sourceRoot: '/',
		server: 'src/server.ts',
		assets: ['client.html'],
		parameters: input.parameters ?? undefined,
		hidden: input.hidden,
	}
	return {
		'kody.json': stringifyManifest(manifest),
		'client.html': `${(input.clientCode ?? '<main></main>').trim()}\n`,
		'src/server.ts': `${(
			input.serverCode ??
			`export default {
  async fetch() {
    return new Response('Package app backend not configured.', { status: 404 })
  },
}`
		).trim()}\n`,
	}
}
