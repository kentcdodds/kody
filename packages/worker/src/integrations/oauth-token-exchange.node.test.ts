import { expect, test } from 'vitest'
import {
	buildOAuthTokenExchangeFailurePayload,
	buildOAuthTokenExchangeRequest,
	oauthTokenExchangeFailureHttpStatus,
	resolveTokenExchangeStyle,
} from './oauth-token-exchange.ts'

test('token exchange style resolves Notion basic-json and builds both request shapes', () => {
	expect(
		resolveTokenExchangeStyle({
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
		}),
	).toBe('basic-json')
	expect(
		resolveTokenExchangeStyle({
			tokenUrl: 'https://slack.com/api/oauth.v2.access',
		}),
	).toBe('form')
	expect(
		resolveTokenExchangeStyle({
			tokenUrl: 'https://api.notion.com/v1/oauth/token',
			tokenExchangeStyle: 'form',
		}),
	).toBe('form')

	const notionRequest = buildOAuthTokenExchangeRequest({
		params: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: 'client-id',
			code: 'code',
			redirect_uri: 'https://example.com/connect/oauth',
		}),
		flow: 'confidential',
		clientSecret: 'client-secret',
		style: 'basic-json',
	})
	expect(notionRequest.headers).toEqual({
		Accept: 'application/json',
		'Content-Type': 'application/json',
		Authorization: `Basic ${btoa('client-id:client-secret')}`,
	})
	expect(JSON.parse(notionRequest.body)).toEqual({
		grant_type: 'authorization_code',
		code: 'code',
		redirect_uri: 'https://example.com/connect/oauth',
	})

	const formRequest = buildOAuthTokenExchangeRequest({
		params: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: 'client-id',
			code: 'code',
			redirect_uri: 'https://example.com/connect/oauth',
		}),
		flow: 'confidential',
		clientSecret: 'client-secret',
		style: 'form',
	})
	expect(formRequest.headers).toEqual({
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
	})
	expect(new URLSearchParams(formRequest.body).get('client_secret')).toBe(
		'client-secret',
	)

	const formPkceConfidentialRequest = buildOAuthTokenExchangeRequest({
		params: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: 'client-id',
			code: 'code',
			redirect_uri: 'https://example.com/connect/oauth',
			code_verifier: 'pkce-verifier',
		}),
		flow: 'confidential',
		clientSecret: 'client-secret',
		style: 'form',
	})
	const formPkceConfidentialBody = new URLSearchParams(
		formPkceConfidentialRequest.body,
	)
	expect(formPkceConfidentialBody.get('client_secret')).toBe('client-secret')
	expect(formPkceConfidentialBody.get('code_verifier')).toBe('pkce-verifier')

	expect(oauthTokenExchangeFailureHttpStatus()).toBe(502)
	expect(
		buildOAuthTokenExchangeFailurePayload({
			providerStatus: 401,
			payload: {
				error: 'invalid_client',
				error_description: 'Client authentication failed',
			},
		}),
	).toEqual({
		ok: false,
		error: 'invalid_client',
		error_description: 'Client authentication failed',
		providerStatus: 401,
	})
})

test('token exchange style resolves Canva basic-form and keeps PKCE code_verifier alongside Basic client auth', () => {
	expect(
		resolveTokenExchangeStyle({
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
		}),
	).toBe('basic-form')
	expect(
		resolveTokenExchangeStyle({
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			tokenExchangeStyle: 'form',
		}),
	).toBe('form')

	const canvaRequest = buildOAuthTokenExchangeRequest({
		params: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: 'canva-client-id',
			client_secret: 'stale-body-secret',
			code: 'canva-code',
			redirect_uri: 'https://example.com/connect/oauth',
			code_verifier: 'pkce-verifier',
		}),
		flow: 'confidential',
		clientSecret: 'canva-client-secret',
		style: 'basic-form',
	})
	expect(canvaRequest.headers).toEqual({
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
		Authorization: `Basic ${btoa('canva-client-id:canva-client-secret')}`,
	})
	const canvaBody = new URLSearchParams(canvaRequest.body)
	expect(canvaBody.get('grant_type')).toBe('authorization_code')
	expect(canvaBody.get('code')).toBe('canva-code')
	expect(canvaBody.get('code_verifier')).toBe('pkce-verifier')
	expect(canvaBody.get('client_id')).toBeNull()
	expect(canvaBody.get('client_secret')).toBeNull()

	// Basic-auth credentials are form-urlencoded per RFC 6749 §2.3.1, so
	// reserved characters like ":" and "%" survive the Basic header.
	const reservedCharacterRequest = buildOAuthTokenExchangeRequest({
		params: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: 'client:id',
			code: 'canva-code',
		}),
		flow: 'confidential',
		clientSecret: 'secret%value',
		style: 'basic-form',
	})
	expect(reservedCharacterRequest.headers.Authorization).toBe(
		`Basic ${btoa('client%3Aid:secret%25value')}`,
	)

	// Each validation condition fails independently: PKCE-only flow, missing
	// secret with confidential flow, and missing client_id.
	expect(() =>
		buildOAuthTokenExchangeRequest({
			params: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: 'canva-client-id',
				code: 'canva-code',
			}),
			flow: 'pkce',
			clientSecret: 'canva-client-secret',
			style: 'basic-form',
		}),
	).toThrow(
		'basic-form token exchange requires confidential flow with a client secret.',
	)
	expect(() =>
		buildOAuthTokenExchangeRequest({
			params: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: 'canva-client-id',
				code: 'canva-code',
			}),
			flow: 'confidential',
			clientSecret: null,
			style: 'basic-form',
		}),
	).toThrow(
		'basic-form token exchange requires confidential flow with a client secret.',
	)
	expect(() =>
		buildOAuthTokenExchangeRequest({
			params: new URLSearchParams({
				grant_type: 'authorization_code',
				code: 'canva-code',
			}),
			flow: 'confidential',
			clientSecret: 'canva-client-secret',
			style: 'basic-form',
		}),
	).toThrow('basic-form token exchange requires client_id in params.')
})
