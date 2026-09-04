import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	collectLocalOriginDevVars,
	writeLocalOriginDevConfig,
} from './local-origin-dev-config.ts'

test('keeps an explicit APP_BASE_URL and does not invent Cloudflare vars', () => {
	expect(
		collectLocalOriginDevVars({
			WRANGLER_IS_LOCAL_DEV: 'true',
			APP_BASE_URL: 'http://localhost:4000',
		}),
	).toEqual({
		WRANGLER_IS_LOCAL_DEV: 'true',
		APP_BASE_URL: 'http://localhost:4000',
	})
})

test('always injects WRANGLER_IS_LOCAL_DEV and copies mock Cloudflare vars', () => {
	expect(
		collectLocalOriginDevVars(
			{
				CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
				CLOUDFLARE_API_TOKEN: 'mock-token',
				CLOUDFLARE_ACCOUNT_ID: 'cf_account_mock_123',
				CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
			},
			'3742',
		),
	).toEqual({
		WRANGLER_IS_LOCAL_DEV: 'true',
		APP_BASE_URL: 'http://localhost:3742',
		CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
		CLOUDFLARE_API_TOKEN: 'mock-token',
		CLOUDFLARE_ACCOUNT_ID: 'cf_account_mock_123',
		CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
	})
})

test('writes local-dev vars onto the selected env without dropping committed vars', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'origin-dev-config-'))
	try {
		const originConfigPath = path.join(dir, 'wrangler.jsonc')
		await writeFile(
			originConfigPath,
			JSON.stringify({
				name: 'kody',
				main: './src/index.ts',
				env: {
					production: {
						vars: { SENTRY_ENVIRONMENT: 'production' },
					},
				},
			}),
		)
		const outputPath = await writeLocalOriginDevConfig({
			originConfigPath,
			envName: 'production',
			vars: {
				WRANGLER_IS_LOCAL_DEV: 'true',
				CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
			},
		})
		expect(path.basename(outputPath)).toBe('wrangler-local-dev.generated.json')
		const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
			vars: Record<string, string>
			env: { production: { vars: Record<string, string> } }
		}
		expect(written.env.production.vars).toEqual({
			SENTRY_ENVIRONMENT: 'production',
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
		})
		expect(written.vars).toEqual({
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
		})
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
