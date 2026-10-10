import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createCommunityPackageWebhooksApiHandler } from '#app/handlers/package-webhooks.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	type PackageWebhooksActionPayload,
	type PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

const savedPackage = {
	id: 'pkg-1',
	userId: ownerIdFromStored('set-per-test'),
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
	resolveSavedPackage: vi.fn(
		async (input: { userId: string; packageIdOrKodyId: string }) =>
			input.packageIdOrKodyId === 'pkg-1' ||
			input.packageIdOrKodyId === 'sentry-bridge'
				? { ...savedPackage, userId: input.userId }
				: null,
	),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(async () => [savedPackage]),
	resolveSavedPackageRef: vi.fn(),
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

const apiUrl =
	'https://kody.example/profiles/owner/packages/sentry-bridge/webhooks.json'
const ownerParams = { username: 'owner', kodyId: 'sentry-bridge' }
const otherParams = { username: 'someone-else', kodyId: 'sentry-bridge' }

async function setup(sessionUsername = 'owner') {
	const userId = testStableUserIdFromEmail('owner@example.com')
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'owner@example.com',
		username: sessionUsername,
		mcpUser: { userId },
		request: sessionRequestContext(userId),
	})
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL,
			url_secret_encrypted TEXT,
			hmac_secret_encrypted TEXT,
			previous_url_secret_hash TEXT,
			previous_url_secret_expires_at TEXT,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			deleted_at TEXT,

			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_webhook_endpoints_user_package_name
		ON webhook_endpoints(user_id, package_id, webhook_name);
	`)
	const db = createD1FromSqlite(sqlite)
	const handler = createCommunityPackageWebhooksApiHandler({
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env)
	const run = (request: Request, params = ownerParams) =>
		handler.handler({ request, url: new URL(request.url), params } as never)
	const get = (params = ownerParams) =>
		run(
			new Request(apiUrl, { headers: { Accept: 'application/json' } }),
			params,
		)
	const post = (body: unknown, params = ownerParams) =>
		run(
			new Request(apiUrl, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			}),
			params,
		)
	const act = async (intent: string, webhookName = 'launcher') => {
		const response = await post({ intent, webhookName })
		return {
			status: response.status,
			body: (await response.json()) as PackageWebhooksActionPayload & {
				error: string
			},
		}
	}
	return { db, userId, run, get, post, act }
}

function launcherOf(body: { webhooks: PackageWebhooksLoaderData['webhooks'] }) {
	return body.webhooks.find((webhook) => webhook.name === 'launcher')!
}

function urlSecretOf(url: string) {
	return url.slice(url.lastIndexOf('/') + 1)
}

test('package webhooks API mints, reveals, rotates, and toggles a declared webhook without leaking the URL from the list', async () => {
	const { db, userId, get, act } = await setup()

	const listed = await get()
	expect(listed.status).toBe(200)
	const listBody = (await listed.json()) as PackageWebhooksLoaderData
	expect(listBody).toMatchObject({
		ok: true,
		username: 'owner',
		kodyId: 'sentry-bridge',
	})
	expect(listBody.webhooks.map((webhook) => webhook.id)).toEqual([
		'sentry-bridge/launcher',
		'sentry-bridge/sentry',
	])
	expect(listBody.webhooks[0]).toMatchObject({
		minted: false,
		urlRecoverable: false,
		inputMode: 'params',
		rateLimitPerMinute: 600,
		verification: null,
	})

	const minted = await act('mint')
	expect(minted.status).toBe(200)
	expect(minted.body.revealed?.id).toBe('sentry-bridge/launcher')
	expect(minted.body.revealed?.handle.startsWith('whh_')).toBe(true)
	// The URL comes from the request origin so previews show their own host,
	// and the response reveals it exactly once alongside the refreshed list.
	expect(minted.body.revealed?.url).toMatch(
		/^https:\/\/kody\.example\/@owner\/webhooks\/sentry-bridge\/launcher\/[A-Za-z0-9_-]+$/,
	)
	const mintedUrl = minted.body.revealed!.url
	const mintedHandle = minted.body.revealed!.handle
	expect(launcherOf(minted.body)).toMatchObject({
		minted: true,
		enabled: true,
		urlRecoverable: true,
		handle: mintedHandle,
	})
	expect(JSON.stringify(minted.body.webhooks)).not.toContain(
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
	const relistText = await (await get()).text()
	expect(relistText).not.toContain(urlSecretOf(mintedUrl))
	expect(relistText).not.toContain('"url"')

	const revealed = await act('reveal')
	expect(revealed.status).toBe(200)
	expect(revealed.body.revealed?.url).toBe(mintedUrl)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'webhook_url_reveal',
			result: 'success',
		}),
	)

	// Mint is first-issue only; an existing mint must go through Rotate so a
	// stray click cannot silently invalidate the provider's URL.
	const remint = await act('mint')
	expect(remint.status).toBe(400)
	expect(remint.body.error).toContain('Rotate')

	const disabled = await act('disable')
	expect(disabled.status).toBe(200)
	expect(disabled.body.revealed).toBeUndefined()
	expect(launcherOf(disabled.body).enabled).toBe(false)

	const rotated = await act('rotate')
	expect(rotated.status).toBe(200)
	expect(rotated.body.revealed?.url).not.toBe(mintedUrl)
	expect(rotated.body.revealed?.handle).toBe(mintedHandle)
	const rotatedLauncher = launcherOf(rotated.body)
	// Rotate keeps the disabled state; only Enable flips it back.
	expect(rotatedLauncher.enabled).toBe(false)
	expect(rotatedLauncher.previousUrlActiveUntil).toEqual(expect.any(String))
	const overlapUntil = Date.parse(rotatedLauncher.previousUrlActiveUntil!)
	const overlapExpected = Date.now() + 24 * 60 * 60 * 1000
	expect(overlapUntil).toBeGreaterThan(overlapExpected - 10_000)
	expect(overlapUntil).toBeLessThan(overlapExpected + 10_000)

	const enabled = await act('enable')
	expect(enabled.status).toBe(200)
	expect(launcherOf(enabled.body).enabled).toBe(true)

	const whereLauncher = `WHERE user_id = ? AND package_id = 'pkg-1' AND webhook_name = 'launcher'`
	const stored = await db
		.prepare(
			`SELECT url_secret_encrypted FROM webhook_endpoints ${whereLauncher}`,
		)
		.bind(userId)
		.first<{ url_secret_encrypted: string | null }>()
	expect(stored?.url_secret_encrypted).toBeTruthy()

	// Legacy mints without a recoverable secret list as such and refuse reveal
	// with a message that points at Rotate.
	await db
		.prepare(
			`UPDATE webhook_endpoints SET url_secret_encrypted = NULL ${whereLauncher}`,
		)
		.bind(userId)
		.run()
	const legacyList = (await (await get()).json()) as PackageWebhooksLoaderData
	expect(launcherOf(legacyList).urlRecoverable).toBe(false)
	const legacyReveal = await act('reveal')
	expect(legacyReveal.status).toBe(400)
	expect(legacyReveal.body.error).toContain('not recoverable')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'webhook_url_reveal',
			result: 'failure',
		}),
	)
})

test('package webhooks API is owner-only: another username or an unknown package is a 404 that names neither', async () => {
	// Username matching is case-insensitive, like the `/@username` pages.
	const { get, post } = await setup('Owner')
	expect((await get()).status).toBe(200)

	const someoneElse = await get(otherParams)
	expect(someoneElse.status).toBe(404)
	const someoneElseBody = (await someoneElse.json()) as { error: string }
	expect(someoneElseBody.error).toBe('Package not found.')
	expect(JSON.stringify(someoneElseBody)).not.toContain('sentry')

	const someoneElseMint = await post(
		{ intent: 'mint', webhookName: 'launcher' },
		otherParams,
	)
	expect(someoneElseMint.status).toBe(404)
	expect(logAuditEventSpy).not.toHaveBeenCalledWith(
		expect.objectContaining({ action: 'webhook_url_mint' }),
	)

	const unknownPackage = await get({
		username: 'owner',
		kodyId: 'not-a-package',
	})
	expect(unknownPackage.status).toBe(404)
})

test('package webhooks API rejects unknown webhooks, bad bodies, and anonymous callers', async () => {
	const { db, run, get, act } = await setup()

	const undeclared = await act('mint', 'nope')
	expect(undeclared.status).toBe(400)
	expect(undeclared.body.error).toContain('does not declare webhook')

	const rejected = [
		{ name: 'unminted reveal', intent: 'reveal', webhookName: 'sentry' },
		{ name: 'unknown intent', intent: 'delete', webhookName: 'sentry' },
		{ name: 'blank webhook name', intent: 'mint', webhookName: ' ' },
	]
	for (const { name, intent, webhookName } of rejected) {
		const { status } = await act(intent, webhookName)
		expect({ name, status }).toEqual({ name, status: 400 })
	}

	const wrongMethod = await run(new Request(apiUrl, { method: 'DELETE' }))
	expect(wrongMethod.status).toBe(405)
	expect(wrongMethod.headers.get('Allow')).toBe('GET, POST')

	// Infrastructure failures are audited with their detail but reach the
	// browser only as the generic per-intent message.
	await db.prepare('DROP TABLE webhook_endpoints').run()
	consoleError.mockImplementation(() => {})
	const broken = await act('mint', 'sentry')
	expect(broken.status).toBe(500)
	expect(broken.body.error).toBe('Unable to mint the webhook URL.')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'webhook_url_mint',
			result: 'failure',
			reason: expect.stringContaining('no such table'),
		}),
	)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	expect((await get()).status).toBe(401)
})
