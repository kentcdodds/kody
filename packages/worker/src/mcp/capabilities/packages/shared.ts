import { z } from 'zod'

export const packageFileSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Package-relative file path to write into the saved package repo.',
		),
	content: z.string().describe('Full file contents for this package file.'),
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
