import { type AccountRemoteConnectorsLoaderData } from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { listRemoteConnectorSettingsWithSharedSecrets } from '#worker/remote-connector/settings-service.ts'
import { userScopedConnectorWebSocketUrl } from '@kody-internal/shared/remote-connectors.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export function getConnectorUrlOrigin(request: Request) {
	const url = new URL(request.url)
	const protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
	return `${protocol}//${url.host}`
}

export async function loadAccountRemoteConnectorsData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
}): Promise<AccountRemoteConnectorsLoaderData> {
	const connectorUrlOrigin = getConnectorUrlOrigin(input.request)
	const connectors = await listRemoteConnectorSettingsWithSharedSecrets({
		env: input.env,
		userId: input.user.mcpUser.userId,
	})
	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		connectorUrlOrigin,
		connectors: connectors.map((connector) => ({
			...connector,
			connectorUrl: userScopedConnectorWebSocketUrl({
				origin: connectorUrlOrigin,
				username: input.user.username,
				instanceId: connector.instanceId,
			}),
		})),
	}
}
