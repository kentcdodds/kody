export function formatConnectorConfigFailureMessage(
	error: unknown,
	options: { secretRolledBack: boolean },
) {
	const message =
		error instanceof Error
			? error.message
			: 'Unable to update connector config.'
	return options.secretRolledBack
		? `Connector configuration failed and the secret was rolled back. ${message}`
		: `Connector configuration failed after the secret was saved. ${message}`
}
