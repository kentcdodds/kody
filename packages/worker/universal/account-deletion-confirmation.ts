export const accountDeletionConfirmationPhrase = 'GOODBYE KODY'

export function isAccountDeletionConfirmation(value: string) {
	return value.trim() === accountDeletionConfirmationPhrase
}

/** Homepage query that carries the post-delete confirmation across sign-out. */
const accountDeletedQueryParam = 'accountDeleted'

export const accountDeletedConfirmationMessage =
	'Your Kody account has been deleted'

export function accountDeletedHomePath() {
	return `/?${accountDeletedQueryParam}=1`
}

export function isAccountDeletedHome(search: string) {
	const params = new URLSearchParams(
		search.startsWith('?') ? search.slice(1) : search,
	)
	return params.get(accountDeletedQueryParam) === '1'
}
