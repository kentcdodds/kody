import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createCommunityPackageWebhooksApiHandler } from '#app/handlers/package-webhooks.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	type PackageWebhooksActionPayload,
	type PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

const savedPackage = {
	id: 'pkg-1',
	userId: 'set-per-test',
	name: '@owner/sentry-bridge',
	kodyId: 'sentry-bridge',
	description: 'Sentry bridge',
	tags: [],
	searchText: null,
	sourceId: 'src-1',
	hasApp: false,
	hidden: false,
	isPrivate: true,
	createdAt: '2026-07-24T00:00:00.000Z',
	updatedAt: '2026-07-24T00:00:00.000Z',
}

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: vi.fn(async (input: { packageIdOrKodyId: string }) =>
		input.packageIdOrKodyId === 'pkg-1' ||
		input.packageIdOrKodyId === 'sentry-bridge'
			? savedPackage
			: null,
	),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(async () => [savedPackage]),
	getSavedPackageByKodyId: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(async () => ({
		manifest: {
			name: '@owner/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
				'./dispatch-launcher': './src/dispatch-launcher.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						name: 'sentry',
						export: './handle-sentry-webhook',
						responseMode: 'ack',
						verification: {
							type: 'hmac-sha256',
							header: 'sentry-hook-signature',
							secretName: 'sentryWebhookSecret',
							encoding: 'hex',
						},
					},
					{
						name: 'launcher',
						export: './dispatch-launcher',
						responseMode: 'sync',
						inputMode: 'params',
						rateLimitPerMinute: 600,
					},
				],
			},
		},
	})),
}))

function createEnv() {
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
	`)
	const db = createD1FromSqlite(sqlite)
	return {
		env: {
			APP_DB: db,
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			SENTRY_ENVIRONMENT: 'test',
		} as unknown as Env,
		db,
	}
}

type Handler = {
	handler(context: never): Promise<Response>
}

const ownerParams = { username: 'owner', kodyId: 'sentry-bridge' }

async function runHandler(
	handler: Handler,
	request: Request,
	params: { username: string; kodyId: string } = ownerParams,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params,
	} as never)
}

const apiUrl =
	'https://kody.example/profiles/owner/packages/sentry-bridge/webhooks.json'

function getRequest() {
	return new Request(apiUrl, { headers: { Accept: 'application/json' } })
}

function postRequest(body: unknown) {
	return new Request(apiUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
}

function urlSecretOf(url: string) {
	return url.slice(url.lastIndexOf('/') + 1)
}

test('package webhooks API mints, reveals, rotates, and toggles a declared webhook without leaking the URL from the list', async () => {
	const userId = await createStableUserIdFromEmail('owner@example.com')
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'owner@example.com',
		username: 'owner',
		mcpUser: { userId },
	})
	const { env, db } = createEnv()
	const handler = createCommunityPackageWebhooksApiHandler(env)

	const listed = await runHandler(handler, getRequest())
	expect(listed.status).toBe(200)
	const listBody = (await listed.json()) as PackageWebhooksLoaderData
	expect(listBody.ok).toBe(true)
	expect(listBody.username).toBe('owner')
	expect(listBody.kodyId).toBe('sentry-bridge')
	expect(listBody.webhooks.map((webhook) => webhook.id)).toEqual([
		'sentry-bridge/launcher',
		'sentry-bridge/sentry',
	])
	const launcher = listBody.webhooks[0]!
	expect(launcher.minted).toBe(false)
	expect(launcher.urlRecoverable).toBe(false)
	expect(launcher.inputMode).toBe('params')
	expect(launcher.rateLimitPerMinute).toBe(600)
	expect(launcher.verification).toBeNull()

	const minted = await runHandler(
		handler,
		postRequest({
			intent: 'mint',
			webhookName: 'launcher',
		}),
	)
	expect(minted.status).toBe(200)
	const mintBody = (await minted.json()) as PackageWebhooksActionPayload
	expect(mintBody.revealed?.id).toBe('sentry-bridge/launcher')
	expect(mintBody.revealed?.handle.startsWith('whh_')).toBe(true)
	// The URL comes from the request origin so previews show their own host,
	// and the response reveals it exactly once alongside the refreshed list.
	expect(mintBody.revealed?.url).toMatch(
		/^https:\/\/kody\.example\/@owner\/webhooks\/sentry-bridge\/launcher\/[A-Za-z0-9_-]+$/,
	)
	const mintedUrl = mintBody.revealed!.url
	const mintedLauncher = mintBody.webhooks.find(
		(webhook) => webhook.name === 'launcher',
	)!
	expect(mintedLauncher.minted).toBe(true)
	expect(mintedLauncher.enabled).toBe(true)
	expect(mintedLauncher.urlRecoverable).toBe(true)
	expect(mintedLauncher.handle).toBe(mintBody.revealed?.handle)
	expect(JSON.stringify(mintBody.webhooks)).not.toContain(
		urlSecretOf(mintedUrl),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'webhook_url_mint',
			result: 'success',
			reason: 'package=sentry-bridge webhook=launcher',
		}),
	)

	// GET never carries the credential; only an explicit reveal does.
	const relisted = await runHandler(handler, getRequest())
	const relistText = await relisted.text()
	expect(relistText).not.toContain(urlSecretOf(mintedUrl))
	expect(relistText).not.toContain('"url"')

	const revealed = await runHandler(
		handler,
		postRequest({
			intent: 'reveal',
			webhookName: 'launcher',
		}),
	)
	expect(revealed.status).toBe(200)
	const revealBody = (await revealed.json()) as PackageWebhooksActionPayload
	expect(revealBody.revealed?.url).toBe(mintedUrl)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'webhook_url_reveal',
			result: 'success',
		}),
	)

	// Mint is first-issue only; an existing mint must go through Rotate so a
	// stray click cannot silently invalidate the provider's URL.
	const remint = await runHandler(
		handler,
		postRequest({
			intent: 'mint',
			webhookName: 'launcher',
		}),
	)
	expect(remint.status).toBe(400)
	expect(((await remint.json()) as { error: string }).error).toContain('Rotate')

	const disabled = await runHandler(
		handler,
		postRequest({
			intent: 'disable',
			webhookName: 'launcher',
		}),
	)
	expect(disabled.status).toBe(200)
	const disableBody = (await disabled.json()) as PackageWebhooksActionPayload
	expect(disableBody.revealed).toBeUndefined()
	expect(
		disableBody.webhooks.find((webhook) => webhook.name === 'launcher')
			?.enabled,
	).toBe(false)

	const rotated = await runHandler(
		handler,
		postRequest({
			intent: 'rotate',
			webhookName: 'launcher',
		}),
	)
	expect(rotated.status).toBe(200)
	const rotateBody = (await rotated.json()) as PackageWebhooksActionPayload
	expect(rotateBody.revealed?.url).not.toBe(mintedUrl)
	expect(rotateBody.revealed?.handle).toBe(mintBody.revealed?.handle)
	const rotatedLauncher = rotateBody.webhooks.find(
		(webhook) => webhook.name === 'launcher',
	)!
	// Rotate keeps the disabled state; only Enable flips it back.
	expect(rotatedLauncher.enabled).toBe(false)

	const enabled = await runHandler(
		handler,
		postRequest({
			intent: 'enable',
			webhookName: 'launcher',
		}),
	)
	expect(enabled.status).toBe(200)
	expect(
		((await enabled.json()) as PackageWebhooksActionPayload).webhooks.find(
			(webhook) => webhook.name === 'launcher',
		)?.enabled,
	).toBe(true)

	const stored = await db
		.prepare(
			`SELECT url_secret_encrypted FROM webhook_endpoints
			WHERE user_id = ? AND package_id = 'pkg-1' AND webhook_name = 'launcher'`,
		)
		.bind(userId)
		.first<{ url_secret_encrypted: string | null }>()
	expect(stored?.url_secret_encrypted).toBeTruthy()

	// Legacy mints without a recoverable secret list as such and refuse reveal
	// with a message that points at Rotate.
	await db
		.prepare(
			`UPDATE webhook_endpoints SET url_secret_encrypted = NULL
			WHERE user_id = ? AND package_id = 'pkg-1' AND webhook_name = 'launcher'`,
		)
		.bind(userId)
		.run()
	const legacyList = (await (
		await runHandler(handler, getRequest())
	).json()) as PackageWebhooksLoaderData
	expect(
		legacyList.webhooks.find((webhook) => webhook.name === 'launcher')
			?.urlRecoverable,
	).toBe(false)
	const legacyReveal = await runHandler(
		handler,
		postRequest({
			intent: 'reveal',
			webhookName: 'launcher',
		}),
	)
	expect(legacyReveal.status).toBe(400)
	expect(((await legacyReveal.json()) as { error: string }).error).toContain(
		'not recoverable',
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'webhook_url_reveal',
			result: 'failure',
		}),
	)
})

test('package webhooks API is owner-only: another username or an unknown package is a 404 that names neither', async () => {
	const userId = await createStableUserIdFromEmail('owner@example.com')
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'owner@example.com',
		username: 'Owner',
		mcpUser: { userId },
	})
	const { env } = createEnv()
	const handler = createCommunityPackageWebhooksApiHandler(env)

	// Username matching is case-insensitive, like the `/@username` pages.
	const ownList = await runHandler(handler, getRequest(), {
		username: 'owner',
		kodyId: 'sentry-bridge',
	})
	expect(ownList.status).toBe(200)

	const someoneElse = await runHandler(handler, getRequest(), {
		username: 'someone-else',
		kodyId: 'sentry-bridge',
	})
	expect(someoneElse.status).toBe(404)
	const someoneElseBody = (await someoneElse.json()) as { error: string }
	expect(someoneElseBody.error).toBe('Package not found.')
	expect(JSON.stringify(someoneElseBody)).not.toContain('sentry')

	const someoneElseMint = await runHandler(
		handler,
		postRequest({ intent: 'mint', webhookName: 'launcher' }),
		{ username: 'someone-else', kodyId: 'sentry-bridge' },
	)
	expect(someoneElseMint.status).toBe(404)
	expect(logAuditEventSpy).not.toHaveBeenCalledWith(
		expect.objectContaining({ action: 'webhook_url_mint' }),
	)

	const unknownPackage = await runHandler(handler, getRequest(), {
		username: 'owner',
		kodyId: 'not-a-package',
	})
	expect(unknownPackage.status).toBe(404)
})

test('package webhooks API rejects unknown webhooks, bad bodies, and anonymous callers', async () => {
	const userId = await createStableUserIdFromEmail('owner@example.com')
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'owner@example.com',
		username: 'owner',
		mcpUser: { userId },
	})
	const { env, db } = createEnv()
	const handler = createCommunityPackageWebhooksApiHandler(env)

	const undeclared = await runHandler(
		handler,
		postRequest({
			intent: 'mint',
			webhookName: 'nope',
		}),
	)
	expect(undeclared.status).toBe(400)
	expect(((await undeclared.json()) as { error: string }).error).toContain(
		'does not declare webhook',
	)

	const unminted = await runHandler(
		handler,
		postRequest({
			intent: 'reveal',
			webhookName: 'sentry',
		}),
	)
	expect(unminted.status).toBe(400)

	const badIntent = await runHandler(
		handler,
		postRequest({
			intent: 'delete',
			webhookName: 'sentry',
		}),
	)
	expect(badIntent.status).toBe(400)

	const blank = await runHandler(
		handler,
		postRequest({ intent: 'mint', webhookName: ' ' }),
	)
	expect(blank.status).toBe(400)

	const wrongMethod = await runHandler(
		handler,
		new Request(apiUrl, { method: 'DELETE' }),
	)
	expect(wrongMethod.status).toBe(405)
	expect(wrongMethod.headers.get('Allow')).toBe('GET, POST')

	// Infrastructure failures are audited with their detail but reach the
	// browser only as the generic per-intent message.
	await db.prepare('DROP TABLE webhook_endpoints').run()
	const consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => undefined)
	const broken = await runHandler(
		handler,
		postRequest({
			intent: 'mint',
			webhookName: 'sentry',
		}),
	)
	consoleError.mockRestore()
	expect(broken.status).toBe(500)
	const brokenBody = (await broken.json()) as { error: string }
	expect(brokenBody.error).toBe('Unable to mint the webhook URL.')
	expect(brokenBody.error).not.toContain('no such table')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'webhook_url_mint',
			result: 'failure',
			reason: expect.stringContaining('no such table'),
		}),
	)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await runHandler(handler, getRequest())
	expect(unauthorized.status).toBe(401)
})
