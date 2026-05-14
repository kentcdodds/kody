import { z } from 'zod'

export const packageFileSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Package-relative file path to write into the saved package repo.',
		),
	content: z
		.string()
		.describe(
			'Full file contents for this package file. For README.md, maintain a concise Intent section when creating or materially changing a package.',
		),
})

export const packageSummarySchema = z.object({
	package_id: z.string(),
	kody_id: z.string(),
	name: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	has_app: z.boolean(),
	source_id: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const packageExportSurfaceSchema = z.object({
	subpath: z
		.string()
		.describe('Package export subpath from package.json exports.'),
	import_specifier: z
		.string()
		.describe('Ready-to-use kody: import specifier for this export.'),
	runtime_target: z
		.string()
		.nullable()
		.describe('Package-relative runtime source path for this export.'),
	types_path: z
		.string()
		.nullable()
		.describe(
			'Package-relative types source path for this export, when declared.',
		),
	description: z
		.string()
		.nullable()
		.describe('Export description parsed from JSDoc when available.'),
	type_definition: z
		.string()
		.nullable()
		.describe(
			'Primary export type signature parsed from source when available.',
		),
})

export const packageDetailSchema = packageSummarySchema.extend({
	exports: z.array(packageExportSurfaceSchema),
})
