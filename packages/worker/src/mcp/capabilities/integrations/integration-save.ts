import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	getIntegration,
	upsertIntegration,
	type IntegrationConfig,
} from '#worker/integrations/service.ts'
import {
	integrationConfigSchema,
	integrationSaveSchema,
	mergeIntegrationConfig,
	normalizeIntegrationConfig,
} from './integration-shared.ts'

const inputSchema = integrationSaveSchema

const outputSchema = z.object({
	integration: integrationConfigSchema,
})

export const integrationSaveCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_save',
		description:
			'Create or update an OAuth integration connection for the signed-in user. Names are normalized to a canonical lowercase-kebab provider key. Partial updates merge into the existing connection; matching client credentials reuse a shared OAuth app across connections.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'save',
			'update',
			'upsert',
			'connection',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const existing = await getIntegration({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
			})
			const config = existing
				? mergeIntegrationConfig(existing, args)
				: createNewIntegrationConfig(args)
			const integration = await upsertIntegration({
				env: ctx.env,
				userId: user.userId,
				config,
			})
			return { integration }
		},
	},
)

function createNewIntegrationConfig(
	args: z.infer<typeof inputSchema>,
): IntegrationConfig {
	const parsed = integrationConfigSchema.safeParse({
		name: args.name,
		tokenUrl: args.tokenUrl,
		apiBaseUrl: args.apiBaseUrl ?? null,
		flow: args.flow,
		...(args.usePkce !== undefined ? { usePkce: args.usePkce } : {}),
		clientId: args.clientId,
		clientSecretSecretName: args.clientSecretSecretName ?? null,
		accessTokenSecretName: args.accessTokenSecretName,
		refreshTokenSecretName: args.refreshTokenSecretName ?? null,
		requiredHosts: args.requiredHosts,
		...(args.tokenExchangeStyle !== undefined
			? { tokenExchangeStyle: args.tokenExchangeStyle }
			: {}),
		...(args.authorization !== undefined
			? { authorization: args.authorization }
			: {}),
	})
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => {
				const field = issue.path.join('.') || 'input'
				return `${field}: ${issue.message}`
			})
			.join(', ')
		// Create-time field gaps are caller-fixable (agents omit required
		// secrets names); keep them off Sentry via McpCallerError.
		throw new McpCallerError(
			`Cannot create integration "${args.name}": missing or invalid required fields — ${details}`,
		)
	}
	return normalizeIntegrationConfig(parsed.data)
}
