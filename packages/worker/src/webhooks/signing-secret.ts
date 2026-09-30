import { McpCallerError } from '#mcp/caller-error.ts'
import {
	decryptWebhookHmacSecret,
	encryptWebhookHmacSecret,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { type PackageWebhookManifestEntry } from '#worker/package-registry/manifest.ts'
import { generateWebhookUrlSecret } from './crypto.ts'
import { type WebhookEndpointRecord } from './types.ts'

/**
 * Package-owned HMAC plaintext for apply injection and inbound verify.
 * Prefer ciphertext on the webhook endpoint (package-scoped).
 *
 * Apply (`{{webhookSecret}}`) uses package-owned material only — never a
 * live `verification.secretName` lookup — so changing secretName after a
 * destination Allow cannot swap which credential is injected.
 *
 * Inbound verify may fall back to a provider-issued `secretName` (Sentry).
 * Legacy GitHub-style secretName values are copied onto the endpoint at
 * mint/rotate when present (`resolveHmacCiphertextForMint`).
 */
export async function resolveWebhookHmacSigningSecret(input: {
	env: Env
	userId: string
	endpoint: WebhookEndpointRecord
	verification: NonNullable<PackageWebhookManifestEntry['verification']>
	/**
	 * When true (inbound delivery), allow falling back to verification.secretName
	 * in the secret store. Apply must leave this false.
	 */
	allowLegacySecretNameFallback?: boolean
}): Promise<string> {
	if (input.endpoint.hmacSecretEncrypted) {
		return decryptWebhookHmacSecret(
			input.env,
			input.endpoint.hmacSecretEncrypted,
			userWebhookHmacSecretContext(input.userId, input.endpoint.id),
		)
	}

	const secretName = input.verification.secretName?.trim() ?? ''
	if (!input.allowLegacySecretNameFallback || !secretName) {
		throw new McpCallerError(
			`Webhook "${input.endpoint.webhookName}" declares HMAC verification but has no package-owned signing secret. Call webhookUrlMint (or webhookUrlRotate) so Kody can mint or migrate one onto the webhook URL record.`,
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
 * Ciphertext to write on mint/rotate when the endpoint has no package-owned
 * HMAC yet. Fresh mint when secretName is omitted; legacy copy from the named
 * secret when present (so apply no longer needs a live secrets-list lookup).
 * Returns undefined to leave the column unset / unchanged.
 */
export async function resolveHmacCiphertextForMint(input: {
	env: Env
	userId: string
	endpointId: string
	packageId: string
	verification: PackageWebhookManifestEntry['verification'] | null | undefined
	existingHmacEncrypted: string | null | undefined
}): Promise<string | undefined> {
	if (input.existingHmacEncrypted) return undefined
	if (!input.verification) return undefined

	const secretName = input.verification.secretName?.trim() ?? ''
	if (!secretName) {
		return (
			await mintPackageOwnedWebhookHmacCiphertext({
				env: input.env,
				userId: input.userId,
				endpointId: input.endpointId,
			})
		).encrypted
	}

	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: secretName,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: input.packageId,
		},
	})
	if (!resolved.found || !resolved.value) return undefined

	return encryptWebhookHmacSecret(
		input.env,
		resolved.value,
		userWebhookHmacSecretContext(input.userId, input.endpointId),
	)
}

/**
 * Whether mint should create package-owned HMAC: verification is declared and
 * there is no provider-issued secretName (those stay in the secret store until
 * optionally copied at mint via resolveHmacCiphertextForMint).
 */
export function shouldMintPackageOwnedWebhookHmac(
	verification: PackageWebhookManifestEntry['verification'] | null | undefined,
) {
	if (!verification) return false
	return !(verification.secretName?.trim() ?? '')
}
