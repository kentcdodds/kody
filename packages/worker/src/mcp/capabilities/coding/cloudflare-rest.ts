import { z } from 'zod'
import { createCloudflareRestClient } from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'

const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const inputSchema = z.object({
	method: httpMethodSchema.describe(
		'HTTP method the Cloudflare API endpoint expects (GET for reads; POST, PUT, PATCH, or DELETE when the API docs call for them).',
	),
	path: z
		.string()
		.min(1)
		.describe(
			'Cloudflare API v4 path starting with `/client/v4/` (for example `/client/v4/accounts` or `/client/v4/zones/{zone_id}/dns_records`). Do not include a scheme or host.',
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
		.describe('Optional JSON body for POST, PUT, PATCH, or DELETE requests.'),
})

const outputSchema = z.object({
	status: z.number().describe('HTTP status code from the Cloudflare API.'),
	body: z
		.unknown()
		.nullable()
		.describe('Parsed JSON response body, or null for empty/204 responses.'),
})

function assertSafeCloudflarePath(path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host (for example use `/client/v4/accounts`, not a full URL).',
		)
	}
	if (!trimmed.startsWith('/client/v4/')) {
		throw new Error(
			'path must start with `/client/v4/` — see https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/',
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

export const cloudflareRestCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'cloudflare_rest',
		description:
			'Low-level Cloudflare API v4 access (https://api.cloudflare.com): method, path under `/client/v4/`, optional query, optional JSON body. Supports account-, zone-, and user-scoped endpoints that the configured API token can access.',
		keywords: [
			'cloudflare',
			'api',
			'rest',
			'v4',
			'raw',
			'low-level',
			'workers',
			'd1',
			'r2',
			'dns',
			'zones',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			assertSafeCloudflarePath(args.path)
			const client = createCloudflareRestClient(ctx.env)
			return client.rawRequest({
				method: args.method,
				path: args.path.trim(),
				query: args.query,
				body: args.body,
			})
		},
	},
)
