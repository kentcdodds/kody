/**
 * Ask password managers not to autofill or offer to save this field/form.
 *
 * Use on secret, token, API-key, and other non-login protected inputs. Login
 * and signup are the only documents that stay fillable. Every other page opts
 * out with `data-1p-ignore` on `<body>`
 * (`universal/password-manager-page-ignore.ts`).
 */
export const passwordManagerIgnoreProps = {
	autoComplete: 'off',
	'data-1p-ignore': true,
	'data-lpignore': 'true',
} as const
