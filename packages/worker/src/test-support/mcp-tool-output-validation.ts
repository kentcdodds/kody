import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import {
	mcpToolOutputJsonSchema,
	type McpToolOutputFields,
} from '#mcp/tools/mcp-tool-output.ts'

const jsonSchemaValidator = new AjvJsonSchemaValidator()

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
