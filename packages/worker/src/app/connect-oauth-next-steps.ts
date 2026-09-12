import { buildConnectOauthWhatsNextPrompt } from '#universal/connect-oauth-whats-next.ts'
import { resolveIntegrationProviderName } from '#mcp/tools/integration-package-suggestions.ts'

type ConnectOauthSuggestionProvider = Parameters<
	typeof resolveIntegrationProviderName
>[0]

export type ConnectOauthNextSteps = {
	service: string
	connectionName: string
	prompt: string
}

export function buildConnectOauthNextSteps(input: {
	integrationName: string
	integration: ConnectOauthSuggestionProvider
}): ConnectOauthNextSteps {
	const service = resolveIntegrationProviderName({
		...input.integration,
		name: input.integration.name || input.integrationName,
	})
	const connectionName = input.integrationName
	return {
		service,
		connectionName,
		prompt: buildConnectOauthWhatsNextPrompt({
			service,
			connectionName,
		}),
	}
}
