import { expect, test } from 'bun:test'
import {
	getRemoteAiLocalDevCredentialsError,
	getRemoteAiLocalDevStartupError,
} from './ai-env-validation.ts'

test('getRemoteAiLocalDevCredentialsError lists missing local Cloudflare credentials', () => {
	expect(getRemoteAiLocalDevCredentialsError({})).toBe(
		'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when AI_MODE is "remote" in local dev. Add them to .env before starting `bun run dev`.',
	)
})

test('getRemoteAiLocalDevStartupError returns undefined outside remote mode', () => {
	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: 'mock',
		}),
	).toBeUndefined()
})

test('getRemoteAiLocalDevStartupError lists all missing remote AI startup env vars', () => {
	expect(
		getRemoteAiLocalDevStartupError({
			AI_MODE: 'remote',
		}),
	).toBe(
		'AI_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when AI_MODE is "remote" in local dev. Add them to .env before starting `bun run dev`.',
	)
})
