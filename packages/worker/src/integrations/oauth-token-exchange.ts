import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'

/**
 * Outbound integration token-exchange request styles for `/connect/oauth`.
 *
 * - `form`: application/x-www-form-urlencoded body; confidential clients put
 *   `client_secret` in the body (GitHub/Slack-style).
 * - `basic-json`: HTTP Basic (client_id:client_secret) + JSON body without
 *   credentials in the body (Notion-style).
 * - `basic-form`: HTTP Basic (client_id:client_secret) +
 *   application/x-www-form-urlencoded body without credentials in the body
 *   (Canva-style).
 *
 * Client-secret authentication and PKCE are orthogonal: `params` may carry a
 * PKCE `code_verifier` in any style, so providers like Canva that require both
 * S256 PKCE and a client secret on token exchange are supported.
 */
export const tokenExchangeStyles = ['form', 'basic-json', 'basic-form'] as const
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
	// Canva's token endpoint takes Basic Auth (or form-body credentials) with
	// an urlencoded body: https://www.canva.dev/docs/connect/authentication/
	if (host === 'api.canva.com') return 'basic-form'
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
			const authorization = buildBasicAuthorization({
				params,
				flow: input.flow,
				clientSecret: input.clientSecret,
				style: input.style,
			})
			const bodyObject = Object.fromEntries(params.entries())
			return {
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					Authorization: authorization,
				},
				body: JSON.stringify(bodyObject),
			}
		}
		case 'basic-form': {
			const authorization = buildBasicAuthorization({
				params,
				flow: input.flow,
				clientSecret: input.clientSecret,
				style: input.style,
			})
			return {
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
					Authorization: authorization,
				},
				body: params.toString(),
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
 * Builds the HTTP Basic Authorization header for the basic-* styles and strips
 * the credentials from the body params. Mutates `params`.
 */
function buildBasicAuthorization(input: {
	params: URLSearchParams
	flow: 'pkce' | 'confidential'
	clientSecret: string | null
	style: TokenExchangeStyle
}): string {
	if (input.flow !== 'confidential' || !input.clientSecret) {
		throw new Error(
			`${input.style} token exchange requires confidential flow with a client secret.`,
		)
	}
	const clientId = input.params.get('client_id')?.trim() ?? ''
	if (!clientId) {
		throw new Error(
			`${input.style} token exchange requires client_id in params.`,
		)
	}
	input.params.delete('client_id')
	input.params.delete('client_secret')
	return `Basic ${bytesToBase64(
		new TextEncoder().encode(
			`${formUrlEncodeBasicCredential(clientId)}:${formUrlEncodeBasicCredential(
				input.clientSecret,
			)}`,
		),
	)}`
}

/**
 * RFC 6749 §2.3.1: Basic-auth client credentials are
 * application/x-www-form-urlencoded before being joined with ":" and
 * base64-encoded, so ids or secrets containing ":" or "%" survive intact.
 * A no-op for the alphanumeric credentials real providers issue.
 */
function formUrlEncodeBasicCredential(value: string) {
	return encodeURIComponent(value).replace(/%20/g, '+')
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
