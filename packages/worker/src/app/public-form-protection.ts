import { getRequestIp } from '#worker/audit-log.ts'

export const honeypotFieldName = 'website'
export const turnstileResponseFieldName = 'turnstileToken'

type PublicFormBody = Record<string, unknown>

function readTrimmedString(body: PublicFormBody, fieldName: string) {
	const value = body[fieldName]
	return typeof value === 'string' ? value.trim() : ''
}

export function getTurnstileSiteKey(
	env: Pick<Env, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>,
) {
	const siteKey = env.TURNSTILE_SITE_KEY?.trim()
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim()
	return siteKey && secretKey ? siteKey : null
}

export type PublicFormProtectionResult =
	| { ok: true }
	| { ok: false; response: Response }

export async function verifyPublicFormProtection(input: {
	env: Pick<Env, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>
	request: Request
	body: PublicFormBody
}): Promise<PublicFormProtectionResult> {
	if (readTrimmedString(input.body, honeypotFieldName)) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Unable to submit this form.' },
				{ status: 400 },
			),
		}
	}

	const siteKey = input.env.TURNSTILE_SITE_KEY?.trim()
	const secretKey = input.env.TURNSTILE_SECRET_KEY?.trim()
	// Turnstile is deliberately opt-in so local development, previews, and tests
	// continue to work. A partial configuration also stays disabled because the
	// browser cannot produce a usable token without the public site key.
	if (!siteKey || !secretKey) return { ok: true }

	const token = readTrimmedString(input.body, turnstileResponseFieldName)
	if (!token) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Please complete the human verification challenge.' },
				{ status: 400 },
			),
		}
	}

	const verificationBody = new URLSearchParams({
		secret: secretKey,
		response: token,
	})
	const requestIp = getRequestIp(input.request)
	if (requestIp) verificationBody.set('remoteip', requestIp)

	try {
		const response = await fetch(
			'https://challenges.cloudflare.com/turnstile/v0/siteverify',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: verificationBody,
			},
		)
		const payload = (await response.json().catch(() => null)) as {
			success?: unknown
		} | null
		if (response.ok && payload?.success === true) return { ok: true }
	} catch {
		// The challenge is configured, so a verification outage must not turn
		// into an authentication bypass.
	}

	return {
		ok: false,
		response: Response.json(
			{ error: 'Human verification failed. Please try again.' },
			{ status: 400 },
		),
	}
}
