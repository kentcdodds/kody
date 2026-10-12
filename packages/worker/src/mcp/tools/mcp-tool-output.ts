import { z } from 'zod'

/**
 * Shared helpers for MCP tool `outputSchema` / `structuredContent`.
 *
 * The Zod field records registered on each tool are the single source of truth
 * for the advertised envelope. Clients such as Claude Code validate
 * `structuredContent` against the JSON Schema derived from those fields with
 * `additionalProperties: false`. Server-side Zod `safeParse` strips unknown
 * keys and cannot catch that drift — use `validateMcpToolStructuredContent`
 * from `#worker/test-support/mcp-tool-output-validation.ts` in tests instead.
 * Keep Ajv out of this module: production tools import it for types, and
 * `verbatimModuleSyntax` keeps that import in the Worker startup graph.
 */
export type McpToolOutputFields = Record<string, z.ZodType>

/**
 * Infer the structuredContent object type from a tool's registered Zod field
 * record, preserving required vs optional the same way `z.object(fields)` does
 * (for example `operationId` stays required on the api tool).
 */
export type StructuredContentFromFields<T extends McpToolOutputFields> =
	z.infer<z.ZodObject<T>>

/**
 * Convert a tool's Zod output field record to the JSON Schema shape tools/list
 * advertises (`additionalProperties: false` at the root).
 */
export function mcpToolOutputJsonSchema(fields: McpToolOutputFields) {
	return z.toJSONSchema(z.object(fields), {
		io: 'output',
	}) as Record<string, unknown>
}
