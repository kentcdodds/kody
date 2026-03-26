import { z } from 'zod'
import { secretScopeValues } from '#mcp/secrets/types.ts'

export const secretMetadataSchema = z.object({
	name: z.string(),
	scope: z.enum(secretScopeValues),
	description: z.string(),
	app_id: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	ttl_ms: z.number().int().nonnegative().nullable(),
})
