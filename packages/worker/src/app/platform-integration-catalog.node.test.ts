import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import { upsertPlatformIntegration } from '#worker/integrations/service.ts'
import {
	loadPlatformIntegrationCatalog,
	onboardingFeaturedPlatformIntegrationSlugs,
} from './platform-integration-catalog.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	const provision = (
		slug: string,
		provider: string,
		options: { visibility: 'draft' | 'published'; enabled?: boolean },
	) =>
		upsertPlatformOauthApp({
			db: env.APP_DB,
			env,
			app: {
				slug,
				provider,
				label: provider,
				clientId: `${slug}-client`,
				tokenUrl: `https://${provider}.example/oauth/token`,
				authorizeUrl: `https://${provider}.example/oauth/authorize`,
				flow: 'pkce',
				enabled: options.enabled ?? true,
				visibility: options.visibility,
			},
		})
	return { env, provision }
}

test('onboarding allowlist only surfaces published + enabled built-ins, in allowlist order', async () => {
	const { env, provision } = createEnv()
	await provision('github-platform', 'github', { visibility: 'draft' })
	await provision('google-platform', 'google', { visibility: 'draft' })
	await provision('notion-platform', 'notion', { visibility: 'draft' })
	await provision('slack-platform', 'slack', { visibility: 'draft' })

	const onboarding = (userId: string | null) =>
		loadPlatformIntegrationCatalog({
			env,
			userId,
			order: onboardingFeaturedPlatformIntegrationSlugs,
		})

	// Every built-in starts draft, so onboarding shows nothing.
	expect(await onboarding(null)).toEqual([])

	await provision('slack-platform', 'slack', { visibility: 'published' })
	await provision('github-platform', 'github', { visibility: 'published' })
	await provision('notion-platform', 'notion', {
		visibility: 'published',
		enabled: false,
	})
	await provision('linear-platform', 'linear', { visibility: 'published' })

	// Allowlist order, not insert or alphabetical order; disabled notion and
	// non-allowlisted linear stay out.
	expect((await onboarding(null)).map((item) => item.slug)).toEqual([
		'github-platform',
		'slack-platform',
	])
	expect((await onboarding(null))[0]).toMatchObject({
		slug: 'github-platform',
		label: 'github',
		provider: 'github',
		connectHref:
			'/connect/oauth?provider=github-platform&platform=github-platform',
	})

	// Without an allowlist (account integrations) every discoverable app shows.
	expect(
		(await loadPlatformIntegrationCatalog({ env, userId: null })).map(
			(item) => item.slug,
		),
	).toEqual(['github-platform', 'linear-platform', 'slack-platform'])

	await upsertPlatformIntegration({
		env,
		userId: 'user-connected',
		platformAppSlug: 'github-platform',
		name: 'github',
		scopes: [],
	})
	expect((await onboarding('user-connected')).map((item) => item.slug)).toEqual(
		['slack-platform'],
	)
})
