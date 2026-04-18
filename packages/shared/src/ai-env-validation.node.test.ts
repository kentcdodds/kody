import { expect, test } from 'vitest'
import {
	getRemoteAiLocalDevCredentialsError,
	getRemoteAiLocalDevStartupError,
} from './ai-env-validation.ts'

test('remote AI env validation reports missing variables only when they matter', () => {
	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: 'mock',
		}),
	).toBeUndefined()

	const credentialsError = getRemoteAiLocalDevCredentialsError({})
	expect(credentialsError).toContain('CLOUDFLARE_ACCOUNT_ID')
	expect(credentialsError).toContain('CLOUDFLARE_API_TOKEN')
	expect(credentialsError).toContain('packages/worker/.env')
	expect(credentialsError).toContain('npm run dev')

	const startupError = getRemoteAiLocalDevStartupError({
		AI_MODE: 'remote',
	})
	expect(startupError).toContain('AI_GATEWAY_ID')
	expect(startupError).toContain('CLOUDFLARE_ACCOUNT_ID')
	expect(startupError).toContain('CLOUDFLARE_API_TOKEN')
	expect(startupError).toContain('AI_MODE is "remote"')

	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: 'remote',
			AI_GATEWAY_ID: 'gateway',
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		}),
	).toBeUndefined()
})
