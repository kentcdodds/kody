import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { z } from 'zod'

/**
 * Shared helpers for MCP tool `outputSchema` / `structuredContent`.
 *
 * The Zod field records registered on each tool are the single source of truth
 * for the advertised envelope. Clients such as Claude Code validate
 * `structuredContent` against the JSON Schema derived from those fields with
 * `additionalProperties: false`. Server-side Zod `safeParse` strips unknown
 * keys and cannot catch that drift — use {@link validateMcpToolStructuredContent}
 * in tests instead.
 */
export type McpToolOutputFields = Record<string, z.ZodType>

export type StructuredContentFromFields<T extends McpToolOutputFields> = {
	[K in keyof T]?: z.infer<T[K]>
}

const jsonSchemaValidator = new AjvJsonSchemaValidator()

/**
 * Convert a tool's Zod output field record to the JSON Schema shape tools/list
 * advertises (`additionalProperties: false` at the root).
 */
export function mcpToolOutputJsonSchema(fields: McpToolOutputFields) {
	return z.toJSONSchema(z.object(fields), {
		io: 'output',
	}) as Record<string, unknown>
}

/**
 * Validate structured content the way strict MCP clients do (Ajv against the
 * advertised JSON Schema). Returns the same error phrasing Claude Code shows
 * when a top-level field is missing from `outputSchema`.
 */
export function validateMcpToolStructuredContent(
	fields: McpToolOutputFields,
	structuredContent: unknown,
): { valid: true } | { valid: false; errorMessage: string } {
	const schema = mcpToolOutputJsonSchema(fields)
	const validate = jsonSchemaValidator.getValidator(schema)
	const result = validate(structuredContent)
	if (result.valid) return { valid: true }
	return {
		valid: false,
		errorMessage:
			result.errorMessage ??
			"Structured content does not match the tool's output schema",
	}
}

export function expectMcpToolStructuredContent(
	fields: McpToolOutputFields,
	structuredContent: unknown,
) {
	const result = validateMcpToolStructuredContent(fields, structuredContent)
	if (!result.valid) {
		throw new Error(
			`Structured content does not match the tool's output schema: ${result.errorMessage}`,
		)
	}
}
