import { McpCallerError } from '#mcp/caller-error.ts'
import {
	decryptWebhookHmacSecret,
	encryptWebhookHmacSecret,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { type PackageWebhookManifestEntry } from '#worker/package-registry/manifest.ts'
import { generateWebhookUrlSecret } from './crypto.ts'
import { setWebhookEndpointHmacSecret } from './repo.ts'
import { type WebhookEndpointRecord } from './types.ts'

/**
 * Package-owned HMAC plaintext for apply injection and inbound verify.
 * Prefer ciphertext on the webhook endpoint (package-scoped). Legacy
 * `verification.secretName` in the user/package secret store is a fallback;
 * when apply migrates, that value is copied onto the endpoint so the secrets
 * list entry can be removed.
 */
export async function resolveWebhookHmacSigningSecret(input: {
	env: Env
	userId: string
	endpoint: WebhookEndpointRecord
	verification: NonNullable<PackageWebhookManifestEntry['verification']>
	/**
	 * When true (apply {{webhookSecret}}), copy a legacy secretName value onto
	 * the endpoint so later verify/apply do not need the user secrets entry.
	 */
	migrateLegacySecretNameToEndpoint?: boolean
}): Promise<string> {
	if (input.endpoint.hmacSecretEncrypted) {
		return decryptWebhookHmacSecret(
			input.env,
			input.endpoint.hmacSecretEncrypted,
			userWebhookHmacSecretContext(input.userId, input.endpoint.id),
		)
	}

	const secretName = input.verification.secretName?.trim() ?? ''
	if (!secretName) {
		throw new McpCallerError(
			`Webhook "${input.endpoint.webhookName}" declares HMAC verification but has no package-owned signing secret. Call webhookUrlMint (or webhookUrlRotate) so Kody can mint one on the webhook URL record.`,
		)
	}

	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: secretName,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: input.endpoint.packageId,
		},
	})
	if (!resolved.found || !resolved.value) {
		throw new McpCallerError(
			`Secret "${secretName}" was not found for this user. Prefer omitting verification.secretName so Kody mints a package-owned HMAC on webhookUrlMint, or restore the named secret.`,
		)
	}

	if (input.migrateLegacySecretNameToEndpoint) {
		const encrypted = await encryptWebhookHmacSecret(
			input.env,
			resolved.value,
			userWebhookHmacSecretContext(input.userId, input.endpoint.id),
		)
		await setWebhookEndpointHmacSecret({
			db: input.env.APP_DB,
			userId: input.userId,
			endpointId: input.endpoint.id,
			hmacSecretEncrypted: encrypted,
		})
	}

	return resolved.value
}

/** Mint ciphertext for a new package-owned HMAC (verification without secretName). */
export async function mintPackageOwnedWebhookHmacCiphertext(input: {
	env: Env
	userId: string
	endpointId: string
}): Promise<{ plaintext: string; encrypted: string }> {
	const plaintext = await generateWebhookUrlSecret()
	const encrypted = await encryptWebhookHmacSecret(
		input.env,
		plaintext,
		userWebhookHmacSecretContext(input.userId, input.endpointId),
	)
	return { plaintext, encrypted }
}

/**
 * Whether mint should create package-owned HMAC: verification is declared and
 * there is no provider-issued secretName (those stay in the secret store).
 */
export function shouldMintPackageOwnedWebhookHmac(
	verification: PackageWebhookManifestEntry['verification'] | null | undefined,
) {
	if (!verification) return false
	return !(verification.secretName?.trim() ?? '')
}
