import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	createAccountWebhooksApiHandler,
	createAccountWebhooksHandler,
} from '#app/handlers/account-webhooks.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type AccountWebhooksLoaderData } from '#universal/loader-data.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	renderAppPage: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mockModule.renderAppPage(...args),
}))

const savedPackages = [
	{
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
	},
	{
		id: 'pkg-2',
		userId: 'set-per-test',
		name: '@owner/raycast',
		kodyId: 'raycast',
		description: 'Raycast bridge',
		tags: [],
		searchText: null,
		sourceId: 'src-2',
		hasApp: false,
		hidden: false,
		isPrivate: true,
		createdAt: '2026-07-24T00:00:00.000Z',
		updatedAt: '2026-07-24T00:00:00.000Z',
	},
]

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(async () => savedPackages),
	getSavedPackageByKodyId: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(async (input: { sourceId: string }) => ({
		manifest:
			input.sourceId === 'src-1'
				? {
						name: '@owner/sentry-bridge',
						exports: { './handle-sentry-webhook': './src/sentry.ts' },
						kody: {
							id: 'sentry-bridge',
							webhooks: [{ name: 'sentry', export: './handle-sentry-webhook' }],
						},
					}
				: {
						name: '@owner/raycast',
						exports: {
							'./list-commands': './src/list-commands.ts',
							'./run': './src/run.ts',
						},
						kody: {
							id: 'raycast',
							webhooks: [
								{
									name: 'list-commands',
									export: './list-commands',
									responseMode: 'sync',
									inputMode: 'params',
								},
								{
									name: 'run',
									export: './run',
									responseMode: 'sync',
									inputMode: 'params',
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
	`)
	return {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(handler: Handler, request: Request) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

const owner = {
	email: 'owner@example.com',
	username: 'owner',
}

test('account webhooks page embeds every package’s declared webhooks (never a URL) and redirects anonymous visitors', async () => {
	const userId = await createStableUserIdFromEmail(owner.email)
	const handler = createAccountWebhooksHandler(createEnv())
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		...owner,
		mcpUser: { userId },
	})
	mockModule.renderAppPage.mockImplementation(async () => new Response('ok'))

	const page = await runHandler(
		handler,
		new Request('https://kody.example/account/webhooks'),
	)
	expect(page.status).toBe(200)
	expect(mockModule.renderAppPage).toHaveBeenCalledTimes(1)
	const renderInput = mockModule.renderAppPage.mock.calls[0]?.[0] as {
		title: string
		loaderData: { accountWebhooks: AccountWebhooksLoaderData }
	}
	expect(renderInput.title).toBe('Webhooks')
	expect(renderInput.loaderData.accountWebhooks.username).toBe('owner')
	expect(
		renderInput.loaderData.accountWebhooks.webhooks.map(
			(webhook) => webhook.id,
		),
	).toEqual(['raycast/list-commands', 'raycast/run', 'sentry-bridge/sentry'])
	expect(JSON.stringify(renderInput.loaderData)).not.toContain('"url"')

	mockModule.requireAuthenticatedPageUser.mockResolvedValue(
		new Response(null, { status: 302, headers: { Location: '/login' } }),
	)
	const anonymous = await runHandler(
		handler,
		new Request('https://kody.example/account/webhooks'),
	)
	expect(anonymous.status).toBe(302)
	expect(mockModule.renderAppPage).toHaveBeenCalledTimes(1)
})

test('account webhooks API lists across packages and is read-only: mutations belong to the package API', async () => {
	const userId = await createStableUserIdFromEmail(owner.email)
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		...owner,
		mcpUser: { userId },
	})
	const handler = createAccountWebhooksApiHandler(createEnv())
	const apiUrl = 'https://kody.example/account/webhooks.json'

	const listed = await runHandler(
		handler,
		new Request(apiUrl, { headers: { Accept: 'application/json' } }),
	)
	expect(listed.status).toBe(200)
	const body = (await listed.json()) as AccountWebhooksLoaderData
	expect(body.webhooks.map((webhook) => webhook.packageKodyId)).toEqual([
		'raycast',
		'raycast',
		'sentry-bridge',
	])
	expect(body.webhooks.every((webhook) => !webhook.minted)).toBe(true)

	const post = await runHandler(
		handler,
		new Request(apiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				intent: 'mint',
				packageKodyId: 'raycast',
				webhookName: 'run',
			}),
		}),
	)
	expect(post.status).toBe(405)
	expect(post.headers.get('Allow')).toBe('GET')

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await runHandler(handler, new Request(apiUrl))
	expect(unauthorized.status).toBe(401)
})
