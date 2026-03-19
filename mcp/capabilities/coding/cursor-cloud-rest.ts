import { z } from 'zod'
import { createCursorCloudClient } from '#mcp/cursor/cursor-cloud-client.ts'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'

const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const inputSchema = z
	.object({
		method: httpMethodSchema.describe(
			'HTTP method the Cursor Cloud endpoint expects (GET for reads; POST, PUT, PATCH, or DELETE when the API docs call for them).',
		),
		path: z
			.string()
			.min(1)
			.describe(
				'Cursor Cloud API path starting with /v0/ (e.g. GET /v0/agents lists; POST /v0/agents launches an agent — there is no /v0/agents/launch). Do not include a scheme or host. Full reference: https://cursor.com/docs/cloud-agent/api/endpoints',
			),
		query: z
			.record(z.string(), z.string())
			.optional()
			.describe(
				'Optional query string parameters. All values are sent as strings.',
			),
		body: z
			.unknown()
			.optional()
			.describe(
				'Optional JSON body for POST, PUT, PATCH, or DELETE. Launch (POST /v0/agents) requires prompt.text and source.repository (GitHub URL), not repo/task/title fields — see official OpenAPI.',
			),
	})

const outputSchema = z.object({
	status: z.number().describe('HTTP status code from the Cursor API.'),
	body: z
		.unknown()
		.nullable()
		.describe('Parsed JSON response body, or null for empty/204 responses.'),
})

function assertSafeCursorPath(path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host (for example use `/v0/agents`, not a full URL).',
		)
	}
	if (!trimmed.startsWith('/v0/')) {
		throw new Error(
			'path must start with `/v0/` — see https://cursor.com/docs/cloud-agent/api/endpoints',
		)
	}
	if (trimmed.includes('..')) {
		throw new Error('path must not contain `..` segments.')
	}
	if (/[\s#]/.test(trimmed)) {
		throw new Error('path contains disallowed characters.')
	}
	if (trimmed.length > 2048) {
		throw new Error('path exceeds maximum length.')
	}
}

export const cursorCloudRestCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'cursor_cloud_rest',
		description:
			'Low-level Cursor Cloud Agents API access (https://api.cursor.com): method, path under /v0/, optional query, optional JSON body. Launch: POST `/v0/agents` (same path as list; not `/v0/agents/launch`) with prompt.text + source.repository per docs. Use the method each endpoint documents; writes may change agents or use quota. https://cursor.com/docs/cloud-agent/api/endpoints',
		keywords: [
			'cursor',
			'cloud agents',
			'api',
			'rest',
			'raw',
			'low-level',
			'fetch',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			assertSafeCursorPath(args.path)
			const client = createCursorCloudClient(ctx.env)
			return client.rawRequest({
				method: args.method,
				path: args.path.trim(),
				query: args.query,
				body: args.body,
			})
		},
	},
)
