import { expect, test } from 'vitest'
import {
	getRemoteAiLocalDevCredentialsError,
	getRemoteAiLocalDevStartupError,
} from './ai-env-validation.ts'

test('remote AI env validation only blocks local dev when required config is missing', () => {
	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: 'mock',
		}),
	).toBeUndefined()

	expect(
		getRemoteAiLocalDevCredentialsError({
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		}),
	).toBeUndefined()
	expect(
		getRemoteAiLocalDevCredentialsError({
			CLOUDFLARE_ACCOUNT_ID: 'account',
		}),
	).toBeDefined()
	expect(
		getRemoteAiLocalDevCredentialsError({
			CLOUDFLARE_API_TOKEN: 'token',
		}),
	).toBeDefined()

	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: ' remote ',
			AI_GATEWAY_ID: '   ',
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		}),
	).toBeDefined()
	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: 'remote',
		}),
	).toBeDefined()

	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: 'remote',
			AI_GATEWAY_ID: 'gateway',
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		}),
	).toBeUndefined()
})
