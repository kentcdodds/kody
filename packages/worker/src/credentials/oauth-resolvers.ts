/**
 * Resolvers for OAuth integrations. Use, the package's usage mode, and the
 * integration's hosts are checked before the token is read, so a refused
 * host never triggers a token refresh.
 */
import {
	createMissingIntegrationAccessTokenMessage,
	findIntegrationCredentialId,
	resolveIntegrationAccessToken,
} from '#worker/integrations/credentials.ts'
import { assertCanUseIntegration } from '#worker/integrations/package-access.ts'
import { getJoinedIntegration } from '#worker/integrations/service.ts'
import { refreshIntegrationTokens } from '#worker/integrations/token-refresh.ts'
import { assertIntegrationAllowsHost } from '#mcp/execute-modules/integration-host-allowlist.ts'
import {
	authorizeActorUse,
	type CredentialResolver,
	type CredentialTargetFor,
	type ResolverCall,
} from './credential-resolver.ts'

async function authorizeIntegrationUse(
	call: ResolverCall<
		CredentialTargetFor<'integration-token' | 'integration-refresh'>
	>,
	credentialId: string | null,
) {
	const { input, credential } = call
	await authorizeActorUse(call, credentialId)
	await assertCanUseIntegration({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.orgId,
		name: credential.name,
		packageId: input.packageStamp?.packageId ?? null,
		packageKodyId: credential.packageKodyId,
	})
}

/**
 * Tokens are read by name, so a connection replaced after the Use check
 * could hand over the replacement's token. Refuse when the name no longer
 * names the credential that was authorized.
 */
async function assertIntegrationUnchanged(
	call: ResolverCall<
		CredentialTargetFor<'integration-token' | 'integration-refresh'>
	>,
	authorizedId: string | null,
) {
	if ((await findIntegrationId(call)) !== authorizedId) {
		throw new Error(
			createMissingIntegrationAccessTokenMessage(call.credential.name),
		)
	}
}

async function findIntegrationId(
	call: ResolverCall<
		CredentialTargetFor<'integration-token' | 'integration-refresh'>
	>,
) {
	return await findIntegrationCredentialId({
		env: call.input.env,
		userId: call.input.orgId,
		name: call.credential.name,
	})
}

export const integrationTokenResolver: CredentialResolver<'integration-token'> =
	{
		auditSubject: (credential) => ({
			use: credential.use,
			resourceType: 'integration',
			name: credential.name,
			credentialId: null,
			details: { host: credential.requestHost ?? null },
		}),
		async resolve(call) {
			const { input, credential } = call
			const credentialId = await findIntegrationId(call)
			return {
				async authorize() {
					await authorizeIntegrationUse(call, credentialId)
					if (!credential.requestHost) return
					const joined = await getJoinedIntegration({
						env: input.env,
						userId: input.orgId,
						name: credential.name,
					})
					if (!joined) {
						throw new Error(
							createMissingIntegrationAccessTokenMessage(credential.name),
						)
					}
					assertIntegrationAllowsHost(
						credential.name,
						{
							requiredHosts: joined.connection.requiredHosts,
							apiBaseUrl: joined.app.apiBaseUrl,
						},
						credential.requestHost,
					)
				},
				async apply() {
					const resolved = await resolveIntegrationAccessToken({
						env: input.env,
						userId: input.orgId,
						name: credential.name,
					})
					await assertIntegrationUnchanged(call, credentialId)
					return resolved?.accessToken ?? null
				},
			}
		},
		isFound: (token) => token !== null,
	}

export const integrationRefreshResolver: CredentialResolver<'integration-refresh'> =
	{
		auditSubject: (credential) => ({
			use: credential.use,
			resourceType: 'integration',
			name: credential.name,
			credentialId: null,
		}),
		async resolve(call) {
			const { input, credential } = call
			const credentialId = await findIntegrationId(call)
			return {
				authorize: () => authorizeIntegrationUse(call, credentialId),
				async apply() {
					// A refresh hands back no token. Checking first keeps an old
					// grant from refreshing a replacement connection; checking
					// after keeps it from being told a replacement swapped in
					// mid-refresh was refreshed for it.
					await assertIntegrationUnchanged(call, credentialId)
					const result = await refreshIntegrationTokens({
						env: input.env,
						userId: input.orgId,
						userEmail: credential.userEmail,
						name: credential.name,
						waitUntil: credential.waitUntil,
					})
					await assertIntegrationUnchanged(call, credentialId)
					return result
				},
			}
		},
		isFound: () => true,
	}
