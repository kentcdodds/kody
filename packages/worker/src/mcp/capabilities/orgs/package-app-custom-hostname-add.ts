import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { packageAppCustomHostnameBindingKinds } from '#worker/package-app-custom-hostnames/types.ts'
import {
	addPackageAppCustomHostname,
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

export const packageAppCustomHostnameAddCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'packageAppCustomHostnameAdd',
		orgPermission: 'org:write',
		description:
			'Register a custom hostname for this organization’s package apps (Cloudflare for SaaS). App-level hostnames apply to one internet-visible public app and serve it at the host root. Org-level hostnames apply to private apps and serve them at /packages/{kodyId} on the custom host. Only org admins may add domains. Point DNS (usually a CNAME) at the package-app zone before verification completes.',
		keywords: [
			'custom domain',
			'hostname',
			'package app',
			'kody.run',
			'DNS',
			'SaaS',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			hostname: z.string().min(1).describe('Customer hostname to register.'),
			binding_kind: z
				.enum(packageAppCustomHostnameBindingKinds)
				.describe('app = one public internet-visible app; org = private apps.'),
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe('Required when binding_kind is app.'),
		}),
		outputSchema: z.object({
			hostname: hostnameSchema,
			dns: z.object({
				type: z.literal('CNAME'),
				name: z.string(),
				target: z.string().nullable(),
			}),
			billing_note: z.string().nullable(),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			if (!request.actor) {
				throw new McpCallerError(
					'Custom hostnames must be added by a person with org:write.',
				)
			}
			try {
				return await addPackageAppCustomHostname({
					env: ctx.env,
					orgId: request.org.id,
					createdByUserId: request.actor.userId,
					bindingKind: args.binding_kind,
					hostname: args.hostname,
					packageId: args.package_id,
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
