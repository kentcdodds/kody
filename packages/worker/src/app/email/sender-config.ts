import { getSystemEmailDomain } from '#worker/email/platform-address.ts'

export type TransactionalEmailEnv = {
	APP_BASE_URL?: string | null
	SYSTEM_EMAIL_DOMAIN?: string | null
	WRANGLER_IS_LOCAL_DEV?: string
}

export type TransactionalEmailConfig = {
	/** Absolute origin used for action links and email assets. */
	appBaseUrl: string
	/** Platform transactional sender: `kody@<sending domain>`. */
	fromEmail: string
}

function tryOrigin(value: string | URL | null | undefined) {
	if (value == null || value === '') return null
	try {
		return new URL(value).origin
	} catch {
		return null
	}
}

/**
 * Resolve the From address and link origin for signup, email-change, and
 * password-reset mail.
 *
 * From always follows the sending domain (`SYSTEM_EMAIL_DOMAIN`, else the
 * `APP_BASE_URL` hostname). Link hosts follow that same domain so a legacy
 * `APP_BASE_URL` or dual-served host cannot pin `heykody.dev` into the
 * message. Local `npm run dev` keeps clickable links on the request origin
 * so signup still works against localhost.
 */
export function resolveTransactionalEmailConfig(input: {
	env: TransactionalEmailEnv
	requestUrl?: string | URL | null
}): TransactionalEmailConfig | null {
	const systemDomain = getSystemEmailDomain(input.env)
	const requestOrigin = tryOrigin(input.requestUrl)
	const configuredOrigin = tryOrigin(input.env.APP_BASE_URL?.trim())
	const fallbackOrigin = configuredOrigin ?? requestOrigin
	const fromHost =
		systemDomain ?? (fallbackOrigin ? new URL(fallbackOrigin).hostname : null)
	if (!fromHost) return null

	const fromEmail = `kody@${fromHost}`
	if (input.env.WRANGLER_IS_LOCAL_DEV === 'true') {
		const localOrigin = requestOrigin ?? configuredOrigin
		if (localOrigin) return { appBaseUrl: localOrigin, fromEmail }
	}
	if (fallbackOrigin && new URL(fallbackOrigin).hostname === fromHost) {
		return { appBaseUrl: fallbackOrigin, fromEmail }
	}
	if (systemDomain) {
		return { appBaseUrl: `https://${systemDomain}`, fromEmail }
	}
	return fallbackOrigin ? { appBaseUrl: fallbackOrigin, fromEmail } : null
}
