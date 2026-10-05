import {
	passwordManagerPageIgnoreAttribute,
	shouldIgnorePasswordManagerPage,
} from '#universal/password-manager-page-ignore.ts'

/**
 * `<body>` lives outside `#root`, so SPA navigations have to add or remove
 * 1Password's page ignore themselves.
 */
export function syncPasswordManagerPageIgnore(pathname: string) {
	if (typeof document === 'undefined') return
	const { body } = document
	if (!body) return
	if (shouldIgnorePasswordManagerPage(pathname)) {
		body.setAttribute(passwordManagerPageIgnoreAttribute, '')
		return
	}
	body.removeAttribute(passwordManagerPageIgnoreAttribute)
}
