import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { afterEach, expect, test, vi } from 'vitest'
import { createDoubleCheck } from '#client/double-check.ts'
import { renderPackageWebhookCard } from '#client/routes/package-webhook-card.tsx'
import { createPackageWebhooksController } from '#client/routes/package-webhook-settings.tsx'
import {
	type PackageWebhookListItem,
	type PackageWebhooksActionPayload,
	type PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'

const ref = { username: 'jane', kodyId: 'raycast' }
const apiPath = '/profiles/jane/packages/raycast/webhooks.json'

const listCommands: PackageWebhookListItem = {
	id: 'raycast/list-commands',
	packageId: 'pkg-2',
	packageKodyId: 'raycast',
	packageName: '@jane/raycast',
	name: 'list-commands',
	exportName: './list-commands',
	description: 'Raycast asks for the command list',
	responseMode: 'sync',
	inputMode: 'params',
	rateLimitPerMinute: 600,
	verification: null,
	replay: null,
	minted: false,
	handle: null,
	urlHost: null,
	enabled: null,
	urlRecoverable: false,
	createdAt: null,
	rotatedAt: null,
}

const run: PackageWebhookListItem = {
	id: 'raycast/run',
	packageId: 'pkg-2',
	packageKodyId: 'raycast',
	packageName: '@jane/raycast',
	name: 'run',
	exportName: './run',
	description: null,
	responseMode: 'sync',
	inputMode: 'params',
	rateLimitPerMinute: 600,
	verification: null,
	replay: { deliveryIdHeader: 'X-Delivery-Id' },
	minted: true,
	handle: 'whh_11111111-1111-1111-1111-111111111111',
	urlHost: 'kody.example',
	enabled: true,
	urlRecoverable: true,
	createdAt: '2026-09-01T10:00:00.000Z',
	rotatedAt: '2026-09-05T10:00:00.000Z',
}

const secretUrl =
	'https://kody.example/@jane/webhooks/raycast/list-commands/s3cr3t-url-secret'

function listPayload(
	webhooks: Array<PackageWebhookListItem>,
): PackageWebhooksLoaderData {
	return { ok: true, username: 'jane', kodyId: 'raycast', webhooks }
}

function createStubHandle() {
	let updates = 0
	const handle = {
		update() {
			updates += 1
			return Promise.resolve(new AbortController().signal)
		},
	} as unknown as Handle
	return {
		handle,
		get updates() {
			return updates
		},
	}
}

const originalFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = originalFetch
})

function stubFetch(
	respond: (input: { url: string; method: string; body: unknown }) => {
		status: number
		body: unknown
	},
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = []
	globalThis.fetch = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString()
			const method = init?.method ?? 'GET'
			const body =
				typeof init?.body === 'string'
					? (JSON.parse(init.body) as unknown)
					: null
			const call = { url, method, body }
			calls.push(call)
			const response = respond(call)
			return new Response(JSON.stringify(response.body), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' },
			})
		},
	) as typeof fetch
	return calls
}

test('the settings section loads one package’s webhooks, then mints, reveals, and hides a URL without ever rendering it from the list payload', async () => {
	let listCommandsState = listCommands
	const calls = stubFetch(({ url, method, body }) => {
		if (method === 'GET') {
			return {
				status: 200,
				body:
					url === apiPath
						? listPayload([listCommandsState, run])
						: { ...listPayload([]), kodyId: 'other' },
			}
		}
		const intent = (body as { intent: string }).intent
		if (intent === 'reveal') {
			const payload: PackageWebhooksActionPayload = {
				...listPayload([listCommandsState, run]),
				revealed: {
					id: listCommands.id,
					handle: listCommandsState.handle ?? '',
					url: secretUrl,
				},
			}
			return { status: 200, body: payload }
		}
		if (intent === 'mint') {
			listCommandsState = {
				...listCommands,
				minted: true,
				enabled: true,
				urlRecoverable: true,
				handle: 'whh_22222222-2222-2222-2222-222222222222',
				urlHost: 'kody.example',
				createdAt: '2026-09-11T10:00:00.000Z',
				rotatedAt: '2026-09-11T10:00:00.000Z',
			}
			const payload: PackageWebhooksActionPayload = {
				...listPayload([listCommandsState, run]),
				revealed: {
					id: listCommands.id,
					handle: listCommandsState.handle!,
					url: secretUrl,
				},
			}
			return { status: 200, body: payload }
		}
		return { status: 400, body: { ok: false, error: `unexpected ${intent}` } }
	})
	const { handle } = createStubHandle()
	const controller = createPackageWebhooksController(handle)

	// Before the load resolves the section announces its state and stays a
	// stable hash target for the account index.
	const loadingHtml = await renderToString(controller.render(ref))
	expect(loadingHtml).toContain('id="webhooks"')
	expect(loadingHtml).toContain('data-testid="package-webhook-settings"')
	expect(loadingHtml).toContain('aria-busy="true"')
	expect(loadingHtml).toContain('Loading webhooks…')

	await controller.ensureLoaded(ref)
	expect(calls).toEqual([{ url: apiPath, method: 'GET', body: null }])
	// Same package again is a no-op; the payload is already applied.
	await controller.ensureLoaded(ref)
	expect(calls).toHaveLength(1)

	const readyHtml = await renderToString(controller.render(ref))
	expect(readyHtml).toContain('2 declared · 1 minted')
	expect(readyHtml).toContain('id="webhook-list-commands"')
	expect(readyHtml).toContain('id="webhook-run"')
	expect(readyHtml).toContain('data-testid="package-webhook-mint"')
	expect(readyHtml).toContain('aria-label="Mint URL for raycast/list-commands"')
	expect(readyHtml).toContain('data-testid="package-webhook-reveal"')
	expect(readyHtml).toContain('aria-label="Reveal URL for raycast/run"')
	expect(readyHtml).toContain('aria-label="Rotate URL for raycast/run"')
	expect(readyHtml).toContain('aria-label="Disable raycast/run"')
	expect(readyHtml).toContain('whh_11111111-1111-1111-1111-111111111111')
	expect(readyHtml).not.toContain('aria-busy="true"')
	expect(readyHtml).not.toContain('/@jane/webhooks/')

	// Mint the way a card click does: the controller posts the intent with
	// only the webhook name (the package is in the URL) and keeps the
	// revealed URL in memory for the copy card.
	await controller.runIntent(ref, listCommands, 'mint')
	expect(calls[1]).toEqual({
		url: apiPath,
		method: 'POST',
		body: { intent: 'mint', webhookName: 'list-commands' },
	})
	const mintedHtml = await renderToString(controller.render(ref))
	expect(mintedHtml).toContain('2 declared · 2 minted')
	expect(mintedHtml).toContain('Webhook URL minted. Copy it now')
	expect(mintedHtml).toContain(secretUrl)
	expect(mintedHtml).toContain('Copy webhook URL')
	expect(mintedHtml).toContain(
		'aria-label="Hide URL for raycast/list-commands"',
	)
	expect(mintedHtml).not.toContain('data-testid="package-webhook-mint"')
	// The other card is untouched: still hidden until its own reveal.
	expect(mintedHtml).toContain('aria-label="Reveal URL for raycast/run"')
	expect(
		mintedHtml.match(/https:\/\/kody\.example\/@jane\/webhooks\//g),
	).toHaveLength(1)

	// Hide drops the URL from memory; the row stays minted.
	controller.hideUrl(listCommands)
	const hiddenHtml = await renderToString(controller.render(ref))
	expect(hiddenHtml).not.toContain(secretUrl)
	expect(hiddenHtml).toContain(
		'aria-label="Reveal URL for raycast/list-commands"',
	)

	// Reveal fetches the URL again (never from the list payload), and
	// switching packages drops it with the rows.
	await controller.runIntent(ref, listCommands, 'reveal')
	expect(calls[2]?.body).toEqual({
		intent: 'reveal',
		webhookName: 'list-commands',
	})
	expect(await renderToString(controller.render(ref))).toContain(secretUrl)
	await controller.ensureLoaded({ username: 'jane', kodyId: 'other' })
	const otherHtml = await renderToString(
		controller.render({ username: 'jane', kodyId: 'other' }),
	)
	expect(otherHtml).not.toContain(secretUrl)
	expect(otherHtml).not.toContain('id="webhook-list-commands"')
})

test('the settings section reports a failed intent and keeps the rows', async () => {
	stubFetch(({ method }) =>
		method === 'GET'
			? { status: 200, body: listPayload([run]) }
			: {
					status: 400,
					body: {
						ok: false,
						error:
							'This webhook already has a URL. Rotate it to issue a new one.',
					},
				},
	)
	const { handle } = createStubHandle()
	const controller = createPackageWebhooksController(handle)
	await controller.ensureLoaded(ref)
	await controller.runIntent(ref, run, 'mint')
	const html = await renderToString(controller.render(ref))
	expect(html).toContain('role="alert"')
	expect(html).toContain('Rotate it to issue a new one.')
	expect(html).toContain('id="webhook-run"')
})

test('a failed load reports the error once and does not refetch on the re-render it triggers', async () => {
	const calls = stubFetch(() => ({
		status: 500,
		body: { ok: false, error: 'boom' },
	}))
	const { handle } = createStubHandle()
	const controller = createPackageWebhooksController(handle)
	await controller.ensureLoaded(ref)
	// The settings route queues ensureLoaded on every render, including the
	// one the failure's update() causes; that pass must be a no-op.
	await controller.ensureLoaded(ref)
	await controller.ensureLoaded(ref)
	expect(calls).toHaveLength(1)
	const html = await renderToString(controller.render(ref))
	expect(html).toContain('role="alert"')
	expect(html).toContain('Unable to load webhooks.')
	expect(html).not.toContain('Loading webhooks…')
})

test('the settings section shows the empty state for a package without webhooks', async () => {
	stubFetch(() => ({ status: 200, body: listPayload([]) }))
	const { handle } = createStubHandle()
	const controller = createPackageWebhooksController(handle)
	await controller.ensureLoaded(ref)
	const html = await renderToString(controller.render(ref))
	expect(html).toContain('data-testid="package-webhook-settings-empty"')
	expect(html).toContain('declares no webhooks yet')
	expect(html).not.toContain('package-webhook-card')
})

test('a webhook card points legacy mints at Rotate instead of Reveal and offers Enable when disabled', async () => {
	const { handle } = createStubHandle()
	const legacy: PackageWebhookListItem = {
		...run,
		urlRecoverable: false,
		enabled: false,
	}
	const html = await renderToString(
		renderPackageWebhookCard({
			webhook: legacy,
			revealedUrl: null,
			isMutating: false,
			rotateCheck: createDoubleCheck(handle),
			disableCheck: createDoubleCheck(handle),
			onIntent: () => {},
			onHideUrl: () => {},
		}),
	)
	expect(html).not.toContain('data-testid="package-webhook-reveal"')
	expect(html).toContain('Rotate it to get a URL you can copy')
	expect(html).toContain('aria-label="Enable raycast/run"')
	expect(html).toContain('>Disabled<')
	expect(html).toContain('600 / min')
	expect(html).toContain('delivery id X-Delivery-Id')
	expect(html).toContain('surface=webhook')
})
