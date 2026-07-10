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
