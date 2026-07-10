import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'

/**
 * Outbound integration token-exchange request styles for `/connect/oauth`.
 *
 * - `form`: application/x-www-form-urlencoded body; confidential clients put
 *   `client_secret` in the body (GitHub/Slack-style).
 * - `basic-json`: HTTP Basic (client_id:client_secret) + JSON body without
 *   credentials in the body (Notion-style).
 */
export const tokenExchangeStyles = ['form', 'basic-json'] as const
export type TokenExchangeStyle = (typeof tokenExchangeStyles)[number]

export function isTokenExchangeStyle(
	value: string,
): value is TokenExchangeStyle {
	return (tokenExchangeStyles as ReadonlyArray<string>).includes(value)
}

export function resolveTokenExchangeStyle(input: {
	tokenUrl: string
	tokenExchangeStyle?: string | null
}): TokenExchangeStyle {
	const explicit = input.tokenExchangeStyle?.trim()
	if (explicit && isTokenExchangeStyle(explicit)) return explicit
	const host = safeParseHost(input.tokenUrl)
	// Notion's token endpoint rejects form-body client_secret and requires
	// Basic Auth + JSON: https://developers.notion.com/guides/get-started/authorization
	if (host === 'api.notion.com') return 'basic-json'
	return 'form'
}

export function buildOAuthTokenExchangeRequest(input: {
	params: URLSearchParams
	flow: 'pkce' | 'confidential'
	clientSecret: string | null
	style: TokenExchangeStyle
}): { headers: Record<string, string>; body: string } {
	const params = new URLSearchParams(input.params)
	switch (input.style) {
		case 'basic-json': {
			if (input.flow !== 'confidential' || !input.clientSecret) {
				throw new Error(
					'basic-json token exchange requires confidential flow with a client secret.',
				)
			}
			const clientId = params.get('client_id')?.trim() ?? ''
			if (!clientId) {
				throw new Error(
					'basic-json token exchange requires client_id in params.',
				)
			}
			params.delete('client_id')
			params.delete('client_secret')
			const bodyObject = Object.fromEntries(params.entries())
			return {
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					Authorization: `Basic ${bytesToBase64(
						new TextEncoder().encode(`${clientId}:${input.clientSecret}`),
					)}`,
				},
				body: JSON.stringify(bodyObject),
			}
		}
		case 'form': {
			if (input.flow === 'confidential') {
				if (!input.clientSecret) {
					throw new Error('Confidential flow requires a client secret.')
				}
				params.set('client_secret', input.clientSecret)
			}
			return {
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: params.toString(),
			}
		}
		default: {
			const exhaustiveCheck: never = input.style
			throw new Error(
				`Unhandled token exchange style: ${String(exhaustiveCheck)}`,
			)
		}
	}
}

/**
 * Provider token-endpoint failures must not reuse HTTP 401 — the connect UI
 * treats 401 from `/account/secrets.json` as an expired Kody session.
 */
export function oauthTokenExchangeFailureHttpStatus(): number {
	return 502
}

export function buildOAuthTokenExchangeFailurePayload(input: {
	providerStatus: number
	payload: Record<string, unknown> | null
}): {
	ok: false
	error: string
	error_description?: string
	providerStatus: number
} {
	const error =
		typeof input.payload?.error === 'string' && input.payload.error.trim()
			? input.payload.error.trim()
			: 'Token exchange failed.'
	const errorDescription =
		typeof input.payload?.error_description === 'string' &&
		input.payload.error_description.trim()
			? input.payload.error_description.trim()
			: null
	return {
		ok: false,
		error,
		...(errorDescription ? { error_description: errorDescription } : {}),
		providerStatus: input.providerStatus,
	}
}
