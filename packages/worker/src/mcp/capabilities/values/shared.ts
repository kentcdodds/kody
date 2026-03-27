import { z } from 'zod'
import { valueScopeValues } from '#mcp/values/types.ts'

export const valueMetadataSchema = z.object({
	name: z.string(),
	scope: z.enum(valueScopeValues),
	value: z.string(),
	description: z.string(),
	app_id: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	ttl_ms: z.number().int().nonnegative().nullable(),
})
