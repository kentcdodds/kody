import { z } from 'zod'
import { uiArtifactParameterSchema } from '#mcp/ui-artifact-parameters.ts'
import { jobScheduleSchema } from '#mcp/capabilities/jobs/shared.ts'

export const appTaskInputSchema = z.object({
	name: z
		.string()
		.min(1)
		.describe('Unique task name inside the app package.'),
	title: z
		.string()
		.min(1)
		.optional()
		.describe('Optional task title. Defaults to the task name.'),
	description: z
		.string()
		.min(1)
		.describe('What this task does.'),
	code: z
		.string()
		.min(1)
		.describe(
			'Task entrypoint module source. It must default export a function so Kody can invoke it with execute semantics.',
		),
	keywords: z.array(z.string()).optional(),
	searchText: z.string().nullable().optional(),
	parameters: z.array(uiArtifactParameterSchema).optional(),
	readOnly: z.boolean().optional(),
	idempotent: z.boolean().optional(),
	destructive: z.boolean().optional(),
	usesCapabilities: z.array(z.string()).optional(),
})

export const appJobInputSchema = z.object({
	id: z.string().min(1).optional(),
	name: z.string().min(1),
	title: z.string().min(1).optional(),
	description: z.string().min(1).optional(),
	task: z.string().min(1).describe('Task name to schedule.'),
	params: z.record(z.string(), z.unknown()).optional(),
	schedule: jobScheduleSchema,
	timezone: z.string().nullable().optional(),
	enabled: z.boolean().optional(),
	killSwitchEnabled: z.boolean().optional(),
	storageId: z.string().min(1).optional(),
})

export const appSaveInputSchema = z.object({
	app_id: z
		.string()
		.min(1)
		.optional()
		.describe('Optional existing app id to update in place. Omit to create a new app.'),
	title: z.string().min(1).describe('App title.'),
	description: z.string().min(1).describe('What the app does and when it is useful.'),
	hidden: z.boolean().optional(),
	keywords: z.array(z.string()).optional(),
	searchText: z.string().nullable().optional(),
	parameters: z.array(uiArtifactParameterSchema).optional(),
	clientCode: z.string().min(1).nullable().optional(),
	serverCode: z.string().min(1).nullable().optional(),
	tasks: z.array(appTaskInputSchema).optional(),
	jobs: z.array(appJobInputSchema).optional(),
	repoCheckPolicy: z
		.object({
			allowTypecheckFailures: z.boolean().optional(),
		})
		.nullable()
		.optional(),
})

export const appGetInputSchema = z.object({
	app_id: z.string().min(1).describe('Saved app id to load.'),
})

export const appTaskViewSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	entrypoint: z.string(),
	keywords: z.array(z.string()).optional(),
	searchText: z.string().nullable().optional(),
	parameters: z.array(uiArtifactParameterSchema).nullable().optional(),
	readOnly: z.boolean().optional(),
	idempotent: z.boolean().optional(),
	destructive: z.boolean().optional(),
	usesCapabilities: z.array(z.string()).nullable().optional(),
})

export const appJobViewSchema = z.object({
	id: z.string(),
	name: z.string(),
	title: z.string(),
	description: z.string(),
	task: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
	schedule: jobScheduleSchema,
	timezone: z.string(),
	enabled: z.boolean(),
	killSwitchEnabled: z.boolean(),
	storageId: z.string(),
	lastRunAt: z.string().optional(),
	lastRunStatus: z.enum(['success', 'error']).optional(),
	lastRunError: z.string().optional(),
	lastDurationMs: z.number().optional(),
	nextRunAt: z.string(),
	runCount: z.number(),
	successCount: z.number(),
	errorCount: z.number(),
	runHistory: z.array(
		z.object({
			startedAt: z.string(),
			finishedAt: z.string(),
			status: z.enum(['success', 'error']),
			durationMs: z.number(),
			error: z.string().optional(),
		}),
	),
	createdAt: z.string(),
	updatedAt: z.string(),
})

export const appViewSchema = z.object({
	version: z.literal(1),
	id: z.string(),
	title: z.string(),
	description: z.string(),
	sourceId: z.string(),
	publishedCommit: z.string().nullable(),
	repoCheckPolicy: z
		.object({
			allowTypecheckFailures: z.boolean().optional(),
		})
		.optional(),
	hidden: z.boolean(),
	keywords: z.array(z.string()),
	searchText: z.string().nullable(),
	parameters: z.array(uiArtifactParameterSchema).nullable(),
	hasClient: z.boolean(),
	hasServer: z.boolean(),
	tasks: z.array(appTaskViewSchema),
	jobs: z.array(appJobViewSchema),
	createdAt: z.string(),
	updatedAt: z.string(),
	jobCount: z.number(),
	taskCount: z.number(),
	scheduleSummary: z.array(z.string()),
})
