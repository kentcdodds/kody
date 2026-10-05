/**
 * Ask password managers not to autofill or offer to save this field/form.
 *
 * Use on secret, token, API-key, and other non-login protected inputs. Keep
 * password-manager behavior on the account sign-in / sign-up flow in
 * `routes/login.tsx` and the OAuth authorize sign-in form in
 * `routes/oauth-authorize.tsx`. Signed-in account shell documents opt the
 * whole page out with `data-1p-ignore` on `<body>`
 * (`universal/password-manager-page-ignore.ts`).
 */
export const passwordManagerIgnoreProps = {
	autoComplete: 'off',
	'data-1p-ignore': true,
	'data-lpignore': 'true',
} as const
