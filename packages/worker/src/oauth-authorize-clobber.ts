import { honeypotFieldName } from '#universal/public-form-protection.ts'

export const oauthAuthorizeClobberedResubmitMessage =
	'This authorization request is missing its original connection details. Use your browser Back button or start the connection again from your client.'

/**
 * Native GET submit of the consent form (no method/action) replaces the OAuth
 * query with only the honeypot field (`kody_hp=`). Missing `client_id` plus
 * that field is that interrupted resubmit, not a well-formed authorize call.
 */
export function isOAuthAuthorizeClobberedResubmit(input: {
	searchParams: URLSearchParams
	formData?: FormData | null
}) {
	if (input.searchParams.get('client_id')?.trim()) return false
	if (input.searchParams.has(honeypotFieldName)) return true
	return input.formData?.has(honeypotFieldName) === true
}
