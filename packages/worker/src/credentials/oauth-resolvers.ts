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
				apply: () =>
					refreshIntegrationTokens({
						env: input.env,
						userId: input.orgId,
						userEmail: credential.userEmail,
						name: credential.name,
						waitUntil: credential.waitUntil,
					}),
			}
		},
		isFound: () => true,
	}
