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
	deleteSecret,
	resolveSecret,
	saveSecret,
} from '#mcp/secrets/service.ts'
import {
	getIntegrationCredentialCiphertexts,
	getOauthAppClientSecretCiphertext,
	clearIntegrationAuthFailure,
	updateIntegrationCredentialCiphertexts,
	updateOauthAppClientSecretCiphertext,
} from './repo.ts'

type CredentialEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

export async function persistIntegrationTokens(input: {
	env: CredentialEnv
	userId: string
	userEmail?: string | null
	name: string
	accessToken: string
	refreshToken?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	descriptionPrefix: string
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

	const storageContext = { sessionId: null, appId: null, packageId: null }
	await saveSecret({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		name: input.accessTokenSecretName,
		value: input.accessToken,
		scope: 'user',
		description: `${input.descriptionPrefix} OAuth access token`,
		storageContext,
	})
	if (refreshToken && input.refreshTokenSecretName) {
		await saveSecret({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			name: input.refreshTokenSecretName,
			value: refreshToken,
			scope: 'user',
			description: `${input.descriptionPrefix} OAuth refresh token`,
			storageContext,
		})
	}
}

export async function persistUserOauthAppClientSecret(input: {
	env: CredentialEnv
	userId: string
	userEmail?: string | null
	slug: string
	value: string
	secretName: string
	description: string
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
	await saveSecret({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		name: input.secretName,
		value: input.value,
		scope: 'user',
		description: input.description,
		storageContext: { sessionId: null, appId: null, packageId: null },
	})
}

export async function resolveIntegrationAccessToken(input: {
	env: CredentialEnv
	userId: string
	name: string
	secretName: string
}): Promise<string | null> {
	const ciphertexts = await getIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (ciphertexts?.accessTokenEncrypted) {
		return decryptUserOauthAccessToken(
			input.env,
			ciphertexts.accessTokenEncrypted,
			userIntegrationCredentialContext(input.userId, input.name),
		)
	}
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: input.secretName,
		scope: 'user',
		storageContext: { sessionId: null, appId: null, packageId: null },
	})
	return resolved.found ? (resolved.value ?? null) : null
}

export async function resolveIntegrationRefreshToken(input: {
	env: CredentialEnv
	userId: string
	name: string
	secretName: string
}): Promise<{
	value: string | null
	allowedHosts: Array<string>
	source: 'integration' | 'secret'
}> {
	const ciphertexts = await getIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (ciphertexts?.refreshTokenEncrypted) {
		return {
			value: await decryptUserOauthRefreshToken(
				input.env,
				ciphertexts.refreshTokenEncrypted,
				userIntegrationCredentialContext(input.userId, input.name),
			),
			allowedHosts: [],
			source: 'integration',
		}
	}
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: input.secretName,
		scope: 'user',
		storageContext: { sessionId: null, appId: null, packageId: null },
	})
	return {
		value: resolved.found ? (resolved.value ?? null) : null,
		allowedHosts: resolved.allowedHosts,
		source: 'secret',
	}
}

export async function resolveUserOauthAppClientSecret(input: {
	env: CredentialEnv
	userId: string
	slug: string
	secretName: string
}): Promise<{
	value: string | null
	allowedHosts: Array<string>
	source: 'integration' | 'secret'
}> {
	const encrypted = await getOauthAppClientSecretCiphertext({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: input.slug,
	})
	if (encrypted) {
		return {
			value: await decryptUserOauthClientSecret(
				input.env,
				encrypted,
				userOauthAppCredentialContext(input.userId, input.slug),
			),
			allowedHosts: [],
			source: 'integration',
		}
	}
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: input.secretName,
		scope: 'user',
		storageContext: { sessionId: null, appId: null, packageId: null },
	})
	return {
		value: resolved.found ? (resolved.value ?? null) : null,
		allowedHosts: resolved.allowedHosts,
		source: 'secret',
	}
}

export async function deleteIntegrationOwnedSecrets(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	secretNames: Array<string | null | undefined>
}): Promise<void> {
	const names = Array.from(
		new Set(
			input.secretNames
				.map((name) => name?.trim())
				.filter((name): name is string => Boolean(name)),
		),
	)
	await Promise.all(
		names.map((name) =>
			deleteSecret({
				env: input.env,
				userId: input.userId,
				name,
				scope: 'user',
				storageContext: { sessionId: null, appId: null, packageId: null },
			}),
		),
	)
}
