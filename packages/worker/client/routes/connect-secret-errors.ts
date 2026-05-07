export function formatIntegrationConfigFailureMessage(
	error: unknown,
	options: {
		secretRolledBack: boolean
		updatedSecretRetained?: boolean
	},
) {
	const message =
		error instanceof Error
			? error.message
			: 'Unable to update integration config.'
	if (options.updatedSecretRetained) {
		return `Integration configuration failed after the secret was updated. ${message}`
	}
	return options.secretRolledBack
		? `Integration configuration failed and the secret was rolled back. ${message}`
		: `Integration configuration failed after the secret was saved. ${message}`
}
