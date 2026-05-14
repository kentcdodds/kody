import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getValue, saveValue } from '#mcp/values/service.ts'
import {
	buildIntegrationValueName,
	integrationConfigSchema,
	integrationSaveSchema,
	mergeIntegrationConfig,
	normalizeIntegrationConfig,
	parseIntegrationConfig,
	parseIntegrationJson,
} from './integration-shared.ts'

const inputSchema = integrationSaveSchema

const outputSchema = z.object({
	integration: integrationConfigSchema,
})

export const integrationSaveCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'integration_save',
		description:
			'Create or update an OAuth integration configuration for the signed-in user. Stored as a user-scoped value with a _integration: prefix.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'save',
			'update',
			'upsert',
			'value',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const storageContext = {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
			}
			const existing = await getValue({
				env: ctx.env,
				userId: user.userId,
				name: buildIntegrationValueName(args.name),
				scope: 'user',
				storageContext,
			})
			const existingIntegration =
				existing == null
					? null
					: parseIntegrationConfig(
							parseIntegrationJson(existing.value),
							args.name,
						)
			const integration = existingIntegration
				? mergeIntegrationConfig(existingIntegration, args)
				: createNewIntegrationConfig(args)
			const value = await saveValue({
				env: ctx.env,
				userId: user.userId,
				name: buildIntegrationValueName(integration.name),
				value: JSON.stringify(integration),
				scope: 'user',
				description: `OAuth integration config for ${integration.name}`,
				storageContext,
			})
			const parsed = parseIntegrationConfig(
				parseIntegrationJson(value.value),
				integration.name,
			)
			return {
				integration: parsed ?? integration,
			}
		},
	},
)

function createNewIntegrationConfig(args: z.infer<typeof inputSchema>) {
	const parsed = integrationConfigSchema.safeParse({
		name: args.name,
		tokenUrl: args.tokenUrl,
		apiBaseUrl: args.apiBaseUrl ?? null,
		flow: args.flow,
		clientIdValueName: args.clientIdValueName,
		clientSecretSecretName: args.clientSecretSecretName ?? null,
		accessTokenSecretName: args.accessTokenSecretName,
		refreshTokenSecretName: args.refreshTokenSecretName ?? null,
		requiredHosts: args.requiredHosts,
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
		throw new Error(
			`Cannot create integration "${args.name}": missing or invalid required fields — ${details}`,
		)
	}
	return normalizeIntegrationConfig(parsed.data)
}
