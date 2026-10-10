import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	decryptUserOauthAccessToken,
	decryptUserOauthClientSecret,
	decryptUserOauthRefreshToken,
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
} from '#mcp/secrets/crypto.ts'
import {
	getIntegrationCredentialCiphertexts,
	getOauthAppClientSecretCiphertext,
	clearIntegrationAuthFailure,
	updateIntegrationCredentialCiphertexts,
	updateOauthAppClientSecretCiphertext,
} from './repo.ts'
import { type IntegrationRefreshPolicy } from './refresh-policy.ts'

type CredentialEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

export function createMissingIntegrationAccessTokenMessage(name: string) {
	return `Integration "${name}" does not have a stored access token.`
}

export async function persistIntegrationTokens(input: {
	env: CredentialEnv
	userId: OwnerId
	name: string
	accessToken: string
	refreshToken?: string | null
	/**
	 * Overwrites the stored policy. `/connect/oauth` passes
	 * `inferIntegrationRefreshPolicy(tokenPayload)` so a reconnect re-decides
	 * it; a successful refresh passes `required`.
	 */
	refreshPolicy: IntegrationRefreshPolicy
}): Promise<void> {
	const context = userIntegrationCredentialContext(input.userId, input.name)
	const accessTokenEncrypted = await encryptUserOauthAccessToken(
		input.env,
		input.accessToken,
		context,
	)
	const refreshToken = input.refreshToken?.trim() || null
	const refreshTokenEncrypted = refreshToken
		? await encryptUserOauthRefreshToken(input.env, refreshToken, context)
		: null
	await updateIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
		accessTokenEncrypted,
		refreshTokenEncrypted,
		refreshPolicy: input.refreshPolicy,
	})
	try {
		await clearIntegrationAuthFailure({
			db: input.env.APP_DB,
			userId: input.userId,
			name: input.name,
		})
	} catch {
		// Clearing last-failure is best-effort; token persist must still succeed.
	}
}

export async function persistUserOauthAppClientSecret(input: {
	env: CredentialEnv
	userId: OwnerId
	slug: string
	value: string
}): Promise<void> {
	const encrypted = await encryptUserOauthClientSecret(
		input.env,
		input.value,
		userOauthAppCredentialContext(input.userId, input.slug),
	)
	await updateOauthAppClientSecretCiphertext({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: input.slug,
		clientSecretEncrypted: encrypted,
	})
}

export async function resolveIntegrationAccessToken(input: {
	env: CredentialEnv
	userId: OwnerId
	name: string
}): Promise<string | null> {
	const ciphertexts = await getIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (!ciphertexts?.accessTokenEncrypted) return null
	return decryptUserOauthAccessToken(
		input.env,
		ciphertexts.accessTokenEncrypted,
		userIntegrationCredentialContext(input.userId, input.name),
	)
}

export async function resolveIntegrationRefreshToken(input: {
	env: CredentialEnv
	userId: OwnerId
	name: string
}): Promise<string | null> {
	const ciphertexts = await getIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (!ciphertexts?.refreshTokenEncrypted) return null
	return decryptUserOauthRefreshToken(
		input.env,
		ciphertexts.refreshTokenEncrypted,
		userIntegrationCredentialContext(input.userId, input.name),
	)
}

export async function resolveUserOauthAppClientSecret(input: {
	env: CredentialEnv
	userId: OwnerId
	slug: string
}): Promise<string | null> {
	const encrypted = await getOauthAppClientSecretCiphertext({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: input.slug,
	})
	if (!encrypted) return null
	return decryptUserOauthClientSecret(
		input.env,
		encrypted,
		userOauthAppCredentialContext(input.userId, input.slug),
	)
}
