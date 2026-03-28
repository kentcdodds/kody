export function formatConnectorConfigFailureMessage(
	error: unknown,
	options: {
		secretRolledBack: boolean
		updatedSecretRetained?: boolean
	},
) {
	const message =
		error instanceof Error
			? error.message
			: 'Unable to update connector config.'
	if (options.updatedSecretRetained) {
		return `Connector configuration failed after the secret was updated. ${message}`
	}
	return options.secretRolledBack
		? `Connector configuration failed and the secret was rolled back. ${message}`
		: `Connector configuration failed after the secret was saved. ${message}`
}
