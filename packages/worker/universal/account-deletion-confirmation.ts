export const accountDeletionConfirmationPhrase = 'GOODBYE KODY'

export function isAccountDeletionConfirmation(value: string) {
	return value.trim() === accountDeletionConfirmationPhrase
}
