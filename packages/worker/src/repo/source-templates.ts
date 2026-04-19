import { type UiArtifactParameterInput } from '@kody-internal/shared/ui-artifact-parameters.ts'
import { type AppSchedule } from '#worker/apps/types.ts'
import { type SkillParameterInput } from '#mcp/skills/skill-parameters.ts'

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
		kind: 'app' as const,
		title: input.title,
		description: input.description,
		keywords: input.keywords,
		searchText: input.searchText ?? undefined,
		sourceRoot: '/',
		tasks: [
			{
				name: input.collection?.trim() || 'default',
				title: input.title,
				description: input.description,
				entrypoint: 'src/tasks/default.ts',
				keywords: input.keywords,
				searchText: input.searchText ?? undefined,
				parameters: input.parameters ?? undefined,
				readOnly: input.readOnly,
				idempotent: input.idempotent,
				destructive: input.destructive,
				usesCapabilities: input.usesCapabilities ?? undefined,
			},
		],
	}
	return {
		'kody.json': stringifyManifest(manifest),
		'src/tasks/default.ts': `${input.code.trim()}\n`,
	}
}

export function buildJobSourceFiles(input: {
	job: {
		id: string
		name: string
		schedule: AppSchedule
		timezone: string
		taskName?: string | null
	}
	moduleSource?: string | null
}) {
	const manifest = {
		version: 1 as const,
		kind: 'app' as const,
		title: input.job.name,
		description: input.job.name,
		keywords: ['job', 'scheduled'],
		searchText: input.job.name,
		sourceRoot: '/',
		tasks: [
			{
				name: input.job.taskName?.trim() || 'default',
				title: input.job.name,
				description: `${input.job.name} task entrypoint`,
				entrypoint: 'src/tasks/default.ts',
			},
		],
		jobs: [
			{
				name: input.job.name,
				title: input.job.name,
				description: `${input.job.name} scheduled job`,
				task: input.job.taskName?.trim() || 'default',
				schedule: input.job.schedule,
				timezone: input.job.timezone,
				enabled: true,
				killSwitchEnabled: false,
			},
		],
	}
	const files: Record<string, string> = {
		'kody.json': stringifyManifest(manifest),
	}
	if (input.moduleSource != null) {
		files['src/tasks/default.ts'] = `${input.moduleSource.trim()}\n`
	}
	return files
}

export function buildAppSourceFiles(input: {
	title: string
	description: string
	keywords?: Array<string>
	searchText?: string | null
	parameters?: Array<UiArtifactParameterInput> | null
	hidden: boolean
	clientCode: string | null
	serverCode: string | null
	tasks?: Array<{
		name: string
		title: string
		description: string
		entrypoint: string
		keywords?: Array<string>
		searchText?: string | null
		parameters?: Array<UiArtifactParameterInput> | null
		readOnly?: boolean
		idempotent?: boolean
		destructive?: boolean
		usesCapabilities?: Array<string> | null
		code?: string | null
	}>
	jobs?: Array<{
		name: string
		title: string
		description: string
		task: string
		schedule: AppSchedule
		timezone?: string
		enabled?: boolean
		killSwitchEnabled?: boolean
		params?: Record<string, unknown>
	}>
}) {
	const manifest = {
		version: 1 as const,
		kind: 'app' as const,
		title: input.title,
		description: input.description,
		keywords: input.keywords ?? undefined,
		searchText: input.searchText ?? undefined,
		sourceRoot: '/',
		server: input.serverCode != null ? 'src/server.ts' : undefined,
		assets: input.clientCode != null ? ['client.html'] : undefined,
		parameters: input.parameters ?? undefined,
		hidden: input.hidden,
		tasks: input.tasks?.map((task) => ({
			name: task.name,
			title: task.title,
			description: task.description,
			entrypoint: task.entrypoint,
			keywords: task.keywords ?? undefined,
			searchText: task.searchText ?? undefined,
			parameters: task.parameters ?? undefined,
			readOnly: task.readOnly ?? undefined,
			idempotent: task.idempotent ?? undefined,
			destructive: task.destructive ?? undefined,
			usesCapabilities: task.usesCapabilities ?? undefined,
		})),
		jobs: input.jobs?.map((job) => ({
			name: job.name,
			title: job.title,
			description: job.description,
			task: job.task,
			params: job.params ?? undefined,
			schedule: job.schedule,
			timezone: job.timezone ?? undefined,
			enabled: job.enabled ?? undefined,
			killSwitchEnabled: job.killSwitchEnabled ?? undefined,
		})),
	}
	const files: Record<string, string> = {
		'kody.json': stringifyManifest(manifest),
	}
	if (input.clientCode != null) {
		files['client.html'] = `${input.clientCode.trim()}\n`
	}
	if (input.serverCode != null) {
		files['src/server.ts'] = `${input.serverCode.trim()}\n`
	}
	for (const task of input.tasks ?? []) {
		if (task.code != null) {
			files[task.entrypoint] = `${task.code.trim()}\n`
		}
	}
	return files
}
