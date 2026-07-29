import { z } from 'zod'
import { accountExportSectionNames } from '#worker/account/export.ts'

export const accountExportSectionSchema = z.enum(accountExportSectionNames)

export const accountExportManifestOutputSchema = z.object({
	manifest: z.unknown(),
})

export const accountExportSectionOutputSchema = z.object({
	section: accountExportSectionSchema,
	items: z.array(z.unknown()),
	truncated: z.boolean(),
	next_start_after: z.string().nullable(),
	page_size: z.number(),
	warnings: z.array(z.string()),
})
