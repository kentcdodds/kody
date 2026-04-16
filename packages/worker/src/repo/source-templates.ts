import { type UiArtifactParameterInput } from '@kody-internal/shared/ui-artifact-parameters.ts'
import { type SkillParameterInput } from '#mcp/skills/skill-parameters.ts'
import { type JobView } from '#worker/jobs/types.ts'

function stringifyManifest(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`
}

export function buildSkillSourceFiles(input: {
	title: string
	description: string
	keywords: Array<string>
	searchText?: string | null
	collection?: string | null
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	usesCapabilities?: Array<string> | null
	parameters?: Array<SkillParameterInput> | null
	code: string
}) {
	const manifest = {
		version: 1 as const,
		kind: 'skill' as const,
		title: input.title,
		description: input.description,
		keywords: input.keywords,
		searchText: input.searchText ?? undefined,
		sourceRoot: '/',
		entrypoint: 'src/skill.ts',
		collection: input.collection ?? undefined,
		readOnly: input.readOnly,
		idempotent: input.idempotent,
		destructive: input.destructive,
		usesCapabilities: input.usesCapabilities ?? undefined,
		parameters: input.parameters ?? undefined,
	}
	return {
		'kody.json': stringifyManifest(manifest),
		'src/skill.ts': `${input.code.trim()}\n`,
	}
}

export function buildJobSourceFiles(input: {
	job: Pick<JobView, 'name' | 'scheduleSummary' | 'code'>
}) {
	const manifest = {
		version: 1 as const,
		kind: 'job' as const,
		title: input.job.name,
		description: input.job.name,
		keywords: ['job', 'scheduled'],
		searchText: input.job.scheduleSummary,
		sourceRoot: '/',
		entrypoint: 'src/job.ts',
	}
	return {
		'kody.json': stringifyManifest(manifest),
		'src/job.ts': `${(input.job.code ?? 'async () => null').trim()}\n`,
	}
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
    return new Response('Saved app backend not configured.', { status: 404 })
  },
}`
		).trim()}\n`,
	}
}
