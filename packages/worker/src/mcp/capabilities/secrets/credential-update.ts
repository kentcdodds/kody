import { z } from 'zod'
import { authorize } from '#worker/authorization/authorize.ts'
import {
	credentialInjectSchema,
	credentialProviderSchema,
	updateCredentialFields,
} from '#worker/credentials/credential-fields.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	getOrgCredential,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'

const inputSchema = z
	.object({
		credential_id: z
			.string()
			.min(1)
			.describe(
				'Credential id from secretList, the integrations list, or packageGet credential options.',
			),
		provider: credentialProviderSchema
			.nullable()
			.optional()
			.describe(
				'Provider slug (for example "github") package credential needs match against. Null clears it.',
			),
		inject: credentialInjectSchema
			.optional()
			.describe(
				'How a scoped credential client places a secret\'s value: a header with a "{value}" format, basic auth, or a query parameter. OAuth connections and MCP servers always use Authorization: Bearer.',
			),
	})
	.refine((value) => value.provider !== undefined || value.inject, {
		message: 'Provide provider and/or inject.',
	})

const outputSchema = z.object({
	credential_id: z.string(),
	credential_kind: z.enum(['secret', 'integration', 'mcp-server']),
	name: z.string(),
	provider: z.string().nullable(),
	inject: credentialInjectSchema,
})

export const credentialUpdateCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialUpdate',
		orgPermission: 'none',
		description:
			"Set a credential's provider and/or inject (ADR 0068): which package credential needs it can satisfy, and where a scoped `credential(key)` client puts its value. Works for user-scope secrets, OAuth connections, and MCP servers by credential id; needs Write on that credential and is audited. `{{secret:name}}` placeholders ignore both fields, so existing Keys keep working unchanged. Never takes or returns a value.",
		keywords: [
			'credential',
			'provider',
			'inject',
			'header',
			'placement',
			'client',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(parsed, ctx: CapabilityContext) {
			const request = requireMcpRequest(ctx.callerContext)
			const { authorityPackageId } = resolveCallerSecretAuthority({
				storageContext: ctx.callerContext.storageContext,
			})
			if (authorityPackageId) {
				throw new McpCallerError(
					'Package runtimes cannot change a credential’s provider or inject.',
				)
			}
			const orgId = ownerIdFromCaller(ctx.callerContext)
			const credential = await getOrgCredential(
				ctx.env.APP_DB,
				orgId,
				parsed.credential_id,
			)
			if (!credential?.live) {
				await authorize(
					{ env: ctx.env, request },
					'secret:write',
					missingCredentialResource(request.org.id, parsed.credential_id),
				)
				throw new McpCallerError('No credential with that id in this org.')
			}
			await authorize(
				{ env: ctx.env, request },
				`${credentialPermissionFamily(credential.kind)}:write`,
				credentialResource(request.org.id, credential),
			)
			const updated = await updateCredentialFields({
				db: ctx.env.APP_DB,
				orgId,
				credentialId: credential.id,
				update: {
					...(parsed.provider !== undefined
						? { provider: parsed.provider }
						: {}),
					...(parsed.inject ? { inject: parsed.inject } : {}),
				},
				audit: orgAuditWriterFromRequest(ctx.env, request),
			})
			if (updated.credential.kind === 'vault') {
				throw new Error('Vault bindings have no provider or inject.')
			}
			return {
				credential_id: updated.credential.id,
				credential_kind: updated.credential.kind,
				name: updated.credential.name,
				provider: updated.provider,
				inject: updated.inject,
			}
		},
	},
)
