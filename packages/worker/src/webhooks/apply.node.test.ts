import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	applyWebhookUrlForUser,
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
} from './service.ts'

const integrationMocks = vi.hoisted(() => ({
	getJoinedIntegration: vi.fn(),
	resolveIntegrationAccessToken: vi.fn(),
	assertCanUseIntegration: vi.fn(),
	refreshIntegrationTokens: vi.fn(),
}))

const secretMocks = vi.hoisted(() => ({
	resolveSecretForHost: vi.fn(),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	getJoinedIntegration: (...args: Array<unknown>) =>
		integrationMocks.getJoinedIntegration(...args),
}))

vi.mock('#worker/integrations/credentials.ts', () => ({
	resolveIntegrationAccessToken: (...args: Array<unknown>) =>
		integrationMocks.resolveIntegrationAccessToken(...args),
}))

vi.mock('#worker/integrations/package-access.ts', () => ({
	assertCanUseIntegration: (...args: Array<unknown>) =>
		integrationMocks.assertCanUseIntegration(...args),
}))

vi.mock('#worker/integrations/token-refresh.ts', () => ({
	refreshIntegrationTokens: (...args: Array<unknown>) =>
		integrationMocks.refreshIntegrationTokens(...args),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: vi.fn(async (input: { packageIdOrKodyId: string }) => {
		if (
			input.packageIdOrKodyId === 'pkg-1' ||
			input.packageIdOrKodyId === 'sentry-bridge'
		) {
			return {
				id: 'pkg-1',
				kodyId: 'sentry-bridge',
				name: '@owner/sentry-bridge',
				userId: 'ignored',
				sourceId: 'src-1',
			}
		}
		return null
	}),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(async () => []),
	getSavedPackageByKodyId: vi.fn(),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	resolveSecretForHost: (...args: Array<unknown>) =>
		secretMocks.resolveSecretForHost(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(async () => ({
		manifest: {
			name: '@owner/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						name: 'sentry',
						export: './handle-sentry-webhook',
						responseMode: 'ack',
					},
				],
			},
		},
	})),
}))

function mockGithubIntegration() {
	integrationMocks.getJoinedIntegration.mockResolvedValue({
		lane: 'user',
		app: {
			apiBaseUrl: 'https://api.github.com',
			requiredHosts: ['api.github.com'],
		},
		connection: {
			name: 'github',
			requiredHosts: ['api.github.com'],
			usageMode: 'any',
			allowedPackageIds: [],
		},
	})
	integrationMocks.resolveIntegrationAccessToken.mockResolvedValue('ghs_test')
	integrationMocks.assertCanUseIntegration.mockResolvedValue(undefined)
}

async function mintOwnerWebhook() {
	const userId = await createStableUserIdFromEmail('owner@example.com')
	const { env, db } = createEnv(userId)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('owner', 'owner@example.com', 'hash', ?)`,
		)
		.bind(userId)
		.run()
	const minted = await mintWebhookUrlForUser({
		env,
		userId,
		username: 'owner',
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	return { userId, env, db, minted }
}

function createEnv(userId: string) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL,
			url_secret_encrypted TEXT,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_webhook_endpoints_user_package_name
		ON webhook_endpoints(user_id, package_id, webhook_name);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			stable_user_id TEXT NOT NULL
		);
	`)
	const db = createD1FromSqlite(sqlite)
	return {
		env: {
			APP_DB: db,
			APP_BASE_URL: 'https://heykody.dev',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		} as Env,
		db,
		userId,
	}
}

test('webhookUrlApply registers a GitHub hook from a handle without exposing the URL', async () => {
	const { userId, env, db, minted } = await mintOwnerWebhook()
	const revealed = await revealWebhookUrlForWebsite({
		env,
		userId,
		username: 'owner',
		handle: minted.handle,
	})
	mockGithubIntegration()

	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		expect(url).toBe('https://api.github.com/repos/acme/api/hooks')
		expect(init?.redirect).toBe('manual')
		const body = JSON.parse(String(init?.body)) as {
			config: { url: string }
		}
		expect(body.config.url).toBe(revealed.url)
		return new Response(
			JSON.stringify({
				id: 4242,
				config: { url: revealed.url },
			}),
			{ status: 201 },
		)
	})
	vi.stubGlobal('fetch', fetchMock)

	const applied = await applyWebhookUrlForUser({
		env,
		userId,
		username: 'owner',
		handle: minted.handle,
		destination: {
			type: 'github',
			owner: 'acme',
			repo: 'api',
			events: ['push', 'pull_request'],
		},
	})

	expect(applied).toEqual({
		ok: true,
		urlHost: 'heykody.dev',
		httpStatus: 201,
		remoteId: '4242',
		error: null,
	})
	expect(JSON.stringify(applied)).not.toContain(revealed.url)
	expect(JSON.stringify(applied)).not.toContain(
		revealed.url.slice(revealed.url.lastIndexOf('/') + 1),
	)
	expect(fetchMock).toHaveBeenCalledTimes(1)
	expect(integrationMocks.assertCanUseIntegration).toHaveBeenCalledWith(
		expect.objectContaining({
			userId,
			name: 'github',
			packageId: 'pkg-1',
		}),
	)

	await db
		.prepare(
			`UPDATE webhook_endpoints SET url_secret_encrypted = NULL
			WHERE user_id = ?`,
		)
		.bind(userId)
		.run()
	await expect(
		applyWebhookUrlForUser({
			env,
			userId,
			username: 'owner',
			handle: minted.handle,
			destination: { type: 'github', owner: 'acme', repo: 'api' },
		}),
	).rejects.toThrow('not recoverable')

	vi.unstubAllGlobals()
})

test('webhookUrlApply does not follow credential-bearing redirects', async () => {
	const { userId, env, minted } = await mintOwnerWebhook()
	mockGithubIntegration()
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		expect(init?.redirect).toBe('manual')
		return new Response(null, {
			status: 307,
			headers: { Location: 'https://attacker.example/exfil' },
		})
	})
	vi.stubGlobal('fetch', fetchMock)

	const applied = await applyWebhookUrlForUser({
		env,
		userId,
		username: 'owner',
		handle: minted.handle,
		destination: { type: 'github', owner: 'acme', repo: 'api' },
	})

	expect(applied).toEqual({
		ok: false,
		urlHost: 'heykody.dev',
		httpStatus: 307,
		remoteId: null,
		error: 'Destination redirected. Apply does not follow redirects.',
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
	vi.unstubAllGlobals()
})

test('webhookUrlApply fails when the package manifest cannot be loaded', async () => {
	const { userId, env, minted } = await mintOwnerWebhook()
	mockGithubIntegration()
	vi.mocked(loadPackageManifestBySourceId).mockRejectedValueOnce(
		new Error('Saved package source bindings are not available.'),
	)

	await expect(
		applyWebhookUrlForUser({
			env,
			userId,
			username: 'owner',
			handle: minted.handle,
			destination: { type: 'github', owner: 'acme', repo: 'api' },
		}),
	).rejects.toThrow('Could not load the package manifest')
})

test('webhookUrlApply fails when a configured hook secret cannot be resolved', async () => {
	const { userId, env, minted } = await mintOwnerWebhook()
	mockGithubIntegration()
	secretMocks.resolveSecretForHost.mockResolvedValue({
		found: false,
	})
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)

	await expect(
		applyWebhookUrlForUser({
			env,
			userId,
			username: 'owner',
			handle: minted.handle,
			destination: {
				type: 'github',
				owner: 'acme',
				repo: 'api',
				hookSecretName: 'githubHookSecret',
			},
		}),
	).rejects.toThrow('githubHookSecret')
	expect(fetchMock).not.toHaveBeenCalled()
	vi.unstubAllGlobals()
})

test('webhookUrlApply rejects dot-only GitHub slugs', async () => {
	const { userId, env, minted } = await mintOwnerWebhook()
	mockGithubIntegration()

	await expect(
		applyWebhookUrlForUser({
			env,
			userId,
			username: 'owner',
			handle: minted.handle,
			destination: { type: 'github', owner: '..', repo: 'api' },
		}),
	).rejects.toThrow('GitHub owner')
})
