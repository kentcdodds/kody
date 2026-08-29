import { z } from 'zod'
import { type SecretMetadata, secretScopeValues } from '#mcp/secrets/types.ts'

export const secretMetadataSchema = z.object({
	name: z.string(),
	scope: z.enum(secretScopeValues),
	description: z.string(),
	package_id: z.string().nullable(),
	allowed_hosts: z.array(z.string()),
	allowed_packages: z.array(z.string()),
	created_at: z.string(),
	updated_at: z.string(),
	expires_at: z.string().nullable(),
	ttl_ms: z.number().int().nonnegative().nullable(),
})

export function toSecretCapabilityOutput(secret: SecretMetadata) {
	return {
		name: secret.name,
		scope: secret.scope,
		description: secret.description,
		package_id: secret.packageId,
		allowed_hosts: secret.allowedHosts,
		allowed_packages: secret.allowedPackages,
		created_at: secret.createdAt,
		updated_at: secret.updatedAt,
		expires_at: secret.expiresAt,
		ttl_ms: secret.ttlMs,
	}
}
