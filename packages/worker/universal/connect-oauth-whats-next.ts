/**
 * Post-OAuth success prompt the human copies into their agent. Service is the
 * resolved provider (google); connectionName is the saved connection key.
 */
export function buildConnectOauthWhatsNextPrompt(input: {
	service: string
	connectionName: string
}): string {
	return `I just connected to ${input.service} with ${input.connectionName}. What should we do next? Is there a community package we can fork or one we can build to make using this integration easier?`
}
