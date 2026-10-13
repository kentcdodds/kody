import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { packageAppCustomHostnameBindingKinds } from '#worker/package-app-custom-hostnames/types.ts'
import {
	listPackageAppCustomHostnames,
	PackageAppCustomHostnameError,
} from '#worker/package-app-custom-hostnames/service.ts'

const hostnameSchema = z.object({
	id: z.string(),
	hostname: z.string(),
	binding_kind: z.enum(packageAppCustomHostnameBindingKinds),
	package_id: z.string().nullable(),
	org_id: z.string().nullable(),
	hostname_status: z.string(),
	ssl_status: z.string(),
	verified_at: z.string().nullable(),
	dns_missing_since: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const packageAppCustomHostnameListCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'packageAppCustomHostnameList',
		orgPermission: 'org:write',
		description:
			'List custom hostnames registered for this organization’s package apps, including app-level and org-level bindings and their Cloudflare verification status.',
		keywords: ['custom domain', 'hostname', 'package app', 'list', 'DNS'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			hostnames: z.array(hostnameSchema),
		}),
		async handler(_args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			try {
				return await listPackageAppCustomHostnames({
					env: ctx.env,
					orgId: request.org.id,
				})
			} catch (error) {
				if (error instanceof PackageAppCustomHostnameError) {
					throw new McpCallerError(error.message)
				}
				throw error
			}
		},
	},
)
