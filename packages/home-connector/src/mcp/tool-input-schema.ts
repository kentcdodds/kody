import { z } from 'zod'

export type ToolInputSchema = z.ZodRawShape | z.ZodTypeAny

function isZodSchema(schema: ToolInputSchema): schema is z.ZodTypeAny {
	return (
		typeof schema === 'object' &&
		schema !== null &&
		'safeParse' in schema &&
		typeof schema.safeParse === 'function'
	)
}

export function buildToolInputSchema(schema: ToolInputSchema = {}): {
	inputSchema: Record<string, unknown>
	sdkInputSchema: ToolInputSchema
} {
	const zodSchema = isZodSchema(schema) ? schema : z.object(schema)
	return {
		inputSchema: z.toJSONSchema(zodSchema) as Record<string, unknown>,
		sdkInputSchema: schema,
	}
}
