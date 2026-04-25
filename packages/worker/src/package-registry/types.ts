import { z } from 'zod'

export const kodyPackageIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const packageJobScheduleSchema = z.union([
	z.object({
		type: z.literal('cron'),
		expression: z.string().min(1),
	}),
	z.object({
		type: z.literal('interval'),
		every: z.string().min(1),
	}),
	z.object({
		type: z.literal('once'),
		runAt: z.string().min(1),
	}),
])

export type PackageJobSchedule = z.infer<typeof packageJobScheduleSchema>

export const packageJobDefinitionSchema = z.object({
	entry: z.string().min(1),
	schedule: packageJobScheduleSchema,
	timezone: z.string().min(1).optional(),
	enabled: z.boolean().optional(),
})

export type PackageJobDefinition = z.infer<typeof packageJobDefinitionSchema>

export const packageAppDefinitionSchema = z.object({
	entry: z.string().min(1),
	assets: z.string().min(1).optional(),
})

export type PackageAppDefinition = z.infer<typeof packageAppDefinitionSchema>

export const packageSecretMountDefinitionSchema = z.object({
	name: z.string().min(1),
	scope: z.enum(['user', 'app', 'session']).optional(),
	required: z.boolean().optional(),
})

export type PackageSecretMountDefinition = z.infer<
	typeof packageSecretMountDefinitionSchema
>

export const packageServiceModeValues = ['bounded', 'persistent'] as const
export type PackageServiceMode = (typeof packageServiceModeValues)[number]

export const packageServiceDefinitionSchema = z.object({
	entry: z.string().min(1),
	autoStart: z.boolean().optional(),
	mode: z.enum(packageServiceModeValues).optional(),
	timeoutMs: z.number().int().positive().max(300_000).optional(),
})

export type PackageServiceDefinition = z.infer<
	typeof packageServiceDefinitionSchema
>

export const packageSubscriptionDefinitionSchema = z.object({
	topic: z.string().min(1),
	handler: z.string().min(1),
	description: z.string().min(1).optional(),
	filters: z.record(z.string().min(1), z.unknown()).optional(),
})

export type PackageSubscriptionDefinition = z.infer<
	typeof packageSubscriptionDefinitionSchema
>

const packageExportConditionSchema = z
	.object({
		import: z.string().min(1).optional(),
		default: z.string().min(1).optional(),
		types: z.string().min(1).optional(),
	})
	.refine(
		(value) =>
			value.import !== undefined ||
			value.default !== undefined ||
			value.types !== undefined,
		{
			message:
				'Package export condition objects must define at least one of `import`, `default`, or `types`.',
		},
	)

export const packageExportTargetSchema = z.union([
	z.string().min(1),
	packageExportConditionSchema,
])

export type PackageExportTarget = z.infer<typeof packageExportTargetSchema>

export const authoredPackageKodySchema = z.object({
	id: z.string().regex(kodyPackageIdPattern),
	description: z.string().min(1),
	tags: z.array(z.string().min(1)).optional(),
	searchText: z.string().min(1).optional(),
	secretMounts: z
		.record(z.string().min(1), packageSecretMountDefinitionSchema)
		.optional(),
	subscriptions: z
		.record(z.string().min(1), packageSubscriptionDefinitionSchema)
		.optional(),
	app: packageAppDefinitionSchema.optional(),
	services: z
		.record(z.string().min(1), packageServiceDefinitionSchema)
		.optional(),
	jobs: z.record(z.string().min(1), packageJobDefinitionSchema).optional(),
})

export type AuthoredPackageKody = z.infer<typeof authoredPackageKodySchema>

export const authoredPackageJsonSchema = z.object({
	name: z.string().min(1),
	exports: z.record(z.string().min(1), packageExportTargetSchema),
	kody: authoredPackageKodySchema,
})

export type AuthoredPackageJson = z.infer<typeof authoredPackageJsonSchema>

export type SavedPackageRow = {
	id: string
	user_id: string
	name: string
	kody_id: string
	description: string
	tags_json: string
	search_text: string | null
	source_id: string
	has_app: 0 | 1
	created_at: string
	updated_at: string
}

export type SavedPackageRecord = {
	id: string
	userId: string
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	searchText: string | null
	sourceId: string
	hasApp: boolean
	createdAt: string
	updatedAt: string
}
