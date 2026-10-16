import { type Handle } from 'remix/component'
import { renderToString } from 'remix/component/server'
import { expect, test, vi } from 'vitest'
import { createDoubleCheck } from '#client/double-check.ts'
import { renderPackageWebhookCard } from '#client/routes/package-webhook-card.tsx'
import { createPackageWebhooksController } from '#client/routes/package-webhook-settings.tsx'
import {
	webhookStatusColor,
	webhookStatusLabel,
	webhookSuccessMessage,
} from '#client/routes/webhooks-shared.ts'
import {
	type PackageWebhookListItem,
	type PackageWebhooksActionPayload,
	type PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'
import { colors } from '#universal/styles/tokens.ts'

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
	challenge: null,
	minted: false,
	endpointId: null,
	instanceLabel: null,
	handle: null,
	urlHost: null,
	enabled: null,
	approved: false,
	approvalUrl: null,
	urlRecoverable: false,
	createdAt: null,
	rotatedAt: null,
	previousUrlActiveUntil: null,
}

const run: PackageWebhookListItem = {
	...listCommands,
	id: 'raycast/run',
	name: 'run',
	exportName: './run',
	description: null,
	replay: { deliveryIdHeader: 'X-Delivery-Id' },
	minted: true,
	endpointId: '11111111-1111-1111-1111-111111111111',
	instanceLabel: null,
	handle: 'whh_11111111-1111-1111-1111-111111111111',
	urlHost: 'kody.example',
	enabled: true,
	approved: true,
	urlRecoverable: true,
	createdAt: '2026-09-01T10:00:00.000Z',
	rotatedAt: '2026-09-05T10:00:00.000Z',
}

const approveUrl =
	'https://kody.example/@jane/packages/raycast/credentials/approve?enable=webhook%3Alist-commands'
const secretUrl =
	'https://kody.example/@jane/webhooks/raycast/list-commands/s3cr3t-url-secret'
function listPayload(
	webhooks: Array<PackageWebhookListItem>,
): PackageWebhooksLoaderData {
	return { ok: true, username: 'jane', kodyId: 'raycast', webhooks }
}

const stubHandle = {
	update() {
		return Promise.resolve(new AbortController().signal)
	},
} as unknown as Handle

type FetchCall = { url: string; method: string; body: unknown }

/** Stubs fetch for one controller; dispose restores the real fetch. */
function createControllerWithFetch(
	respond: (input: FetchCall) => { status: number; body: unknown },
) {
	const originalFetch = globalThis.fetch
	const calls: Array<FetchCall> = []
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
	const controller = createPackageWebhooksController(stubHandle)
	return {
		calls,
		controller,
		render: (target = ref) => renderToString(controller.render(target)),
		[Symbol.dispose]() {
			globalThis.fetch = originalFetch
		},
	}
}

const renderCard = (webhook: PackageWebhookListItem) =>
	renderToString(
		renderPackageWebhookCard({
			webhook,
			revealedUrl: null,
			isMutating: false,
			rotateCheck: createDoubleCheck(stubHandle),
			disableCheck: createDoubleCheck(stubHandle),
			onIntent: (_payload) => {},
			onHideUrl: () => {},
			deliveriesHref: '/@ada/-/activity?view=recent&status=all&surface=webhook',
		}),
	)

test('the settings section loads one package’s webhooks, then mints, reveals, and hides a URL without ever rendering it from the list payload', async () => {
	let listCommandsState = listCommands
	using harness = createControllerWithFetch(({ url, method, body }) => {
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
				endpointId: '22222222-2222-2222-2222-222222222222',
				instanceLabel: null,
				enabled: true,
				approved: false,
				approvalUrl: approveUrl,
				urlRecoverable: true,
				handle: 'whh_22222222-2222-2222-2222-222222222222',
				urlHost: 'kody.example',
				createdAt: '2026-09-11T10:00:00.000Z',
				rotatedAt: '2026-09-11T10:00:00.000Z',
				previousUrlActiveUntil: null,
			}
			const payload: PackageWebhooksActionPayload = {
				...listPayload([listCommandsState, run]),
				revealed: {
					id: listCommands.id,
					handle: listCommandsState.handle!,
					url: secretUrl,
				},
				approvalUrl: approveUrl,
			}
			return { status: 200, body: payload }
		}
		return { status: 400, body: { ok: false, error: `unexpected ${intent}` } }
	})
	const { calls, controller, render } = harness

	// Before the load resolves the section announces its state and stays a
	// stable hash target for the account index.
	const loadingHtml = await render()
	expect(loadingHtml).toContain('id="webhooks"')
	expect(loadingHtml).toContain('data-testid="package-webhook-settings"')
	expect(loadingHtml).toContain('aria-busy="true"')
	expect(loadingHtml).toContain('Loading webhooks…')

	await controller.ensureLoaded(ref)
	expect(calls).toEqual([{ url: apiPath, method: 'GET', body: null }])
	// Same package again is a no-op; the payload is already applied.
	await controller.ensureLoaded(ref)
	expect(calls).toHaveLength(1)

	const readyHtml = await render()
	expect(readyHtml).toContain('2 declared · 1 minted')
	expect(readyHtml).toContain('id="webhook-list-commands"')
	expect(readyHtml).toContain(
		'id="webhook-run-11111111-1111-1111-1111-111111111111"',
	)
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
	await controller.runIntent(ref, listCommands, { intent: 'mint' })
	expect(calls[1]).toEqual({
		url: apiPath,
		method: 'POST',
		body: { intent: 'mint', webhookName: 'list-commands' },
	})
	const mintedHtml = await render()
	expect(mintedHtml).toContain('2 declared · 2 minted')
	expect(mintedHtml).toContain('Webhook URL minted. Copy it now')
	expect(mintedHtml).toContain('Approve it')
	expect(mintedHtml).toContain('>Needs approval<')
	expect(mintedHtml).toContain('data-testid="package-webhook-approve"')
	expect(mintedHtml).toContain(`href="${approveUrl}"`)
	expect(mintedHtml).not.toContain('aria-label="Enable raycast/list-commands"')
	expect(mintedHtml).not.toContain('aria-label="Disable raycast/list-commands"')
	expect(mintedHtml).toContain(secretUrl)
	expect(mintedHtml).toContain('Copy webhook URL')
	expect(mintedHtml).toContain(
		'aria-label="Hide URL for raycast/list-commands"',
	)
	expect(mintedHtml).not.toContain('data-testid="package-webhook-mint"')
	expect(mintedHtml).not.toContain('package-webhook-signing-secret')
	// The other card is untouched: still hidden until its own reveal.
	expect(mintedHtml).toContain('aria-label="Reveal URL for raycast/run"')
	expect(
		mintedHtml.match(/https:\/\/kody\.example\/@jane\/webhooks\//g),
	).toHaveLength(1)

	// Hide drops the URL from memory; the row stays minted.
	controller.hideUrl(listCommands)
	const hiddenHtml = await render()
	expect(hiddenHtml).not.toContain(secretUrl)
	expect(hiddenHtml).toContain(
		'aria-label="Reveal URL for raycast/list-commands"',
	)

	// Reveal fetches the URL again (never from the list payload), and
	// switching packages drops it with the rows.
	await controller.runIntent(ref, listCommands, { intent: 'reveal' })
	expect(calls[2]?.body).toEqual({
		intent: 'reveal',
		webhookName: 'list-commands',
	})
	const revealedHtml = await render()
	expect(revealedHtml).toContain(secretUrl)
	expect(revealedHtml).not.toContain('package-webhook-signing-secret')
	await controller.ensureLoaded({ username: 'jane', kodyId: 'other' })
	const otherHtml = await render({ username: 'jane', kodyId: 'other' })
	expect(otherHtml).not.toContain(secretUrl)
	expect(otherHtml).not.toContain('id="webhook-list-commands"')
})

test('the settings section reports a failed intent and keeps the rows', async () => {
	using harness = createControllerWithFetch(({ method }) =>
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
	const { controller, render } = harness
	await controller.ensureLoaded(ref)
	await controller.runIntent(ref, run, { intent: 'mint' })
	const html = await render()
	expect(html).toContain('role="alert"')
	expect(html).toContain('Rotate it to issue a new one.')
	expect(html).toContain(
		'id="webhook-run-11111111-1111-1111-1111-111111111111"',
	)
})

test('a failed load reports the error once and does not refetch on the re-render it triggers', async () => {
	using harness = createControllerWithFetch(() => ({
		status: 500,
		body: { ok: false, error: 'boom' },
	}))
	const { calls, controller, render } = harness
	await controller.ensureLoaded(ref)
	// The settings route queues ensureLoaded on every render, including the
	// one the failure's update() causes; that pass must be a no-op.
	await controller.ensureLoaded(ref)
	await controller.ensureLoaded(ref)
	expect(calls).toHaveLength(1)
	const html = await render()
	expect(html).toContain('role="alert"')
	expect(html).toContain('Unable to load webhooks.')
	expect(html).not.toContain('Loading webhooks…')
})

test('the settings section shows the empty state for a package without webhooks', async () => {
	using harness = createControllerWithFetch(() => ({
		status: 200,
		body: listPayload([]),
	}))
	const { controller, render } = harness
	await controller.ensureLoaded(ref)
	const html = await render()
	expect(html).toContain('data-testid="package-webhook-settings-empty"')
	expect(html).toContain('declares no webhooks yet')
	expect(html).not.toContain('package-webhook-card')
})

test('a webhook card points legacy mints at Rotate instead of Reveal and offers Enable when disabled', async () => {
	const html = await renderCard({
		...run,
		urlRecoverable: false,
		enabled: false,
	})
	expect(html).not.toContain('data-testid="package-webhook-reveal"')
	expect(html).toContain('aria-label="Enable raycast/run"')
	expect(html).toContain('>Disabled<')
	expect(html).toContain('600 / min')
	expect(html).toContain('delivery id X-Delivery-Id')
	expect(html).toContain('surface=webhook')
})

test('a webhook card shows previous URL overlap until the grace timestamp', async () => {
	const until = '2026-09-13T15:04:05.000Z'
	const overlapping = { ...run, previousUrlActiveUntil: until }
	const html = await renderCard(overlapping)
	expect(html).toContain('Previous URL')
	expect(html).toContain('active until')
	expect(html).toContain(new Date(until).toLocaleString())

	const disabledHtml = await renderCard({ ...overlapping, enabled: false })
	expect(disabledHtml).not.toContain('Previous URL')
	expect(disabledHtml).toContain('>Disabled<')
})

test('a minted webhook nobody approved shows Needs approval with an Approve link instead of Enable', async () => {
	const unapproved = {
		...run,
		approved: false,
		approvalUrl: approveUrl,
	}
	const html = await renderCard(unapproved)
	expect(html).toContain('>Needs approval<')
	expect(html).not.toContain('>Active<')
	expect(html).toContain('data-testid="package-webhook-approve"')
	expect(html).toContain('aria-label="Approve raycast/run"')
	expect(html).toContain(`href="${approveUrl}"`)
	expect(html).not.toContain('aria-label="Enable raycast/run"')
	expect(html).not.toContain('aria-label="Disable raycast/run"')
	expect(html).toContain('aria-label="Rotate URL for raycast/run"')

	// Even a mint whose endpoint is switched off needs Approve first.
	const unapprovedDisabled = await renderCard({ ...unapproved, enabled: false })
	expect(unapprovedDisabled).toContain('>Needs approval<')
	expect(unapprovedDisabled).not.toContain('aria-label="Enable raycast/run"')
})

test('an approved webhook keeps the Active status and Disable action with no Approve link', async () => {
	const html = await renderCard(run)
	expect(html).toContain('>Active<')
	expect(html).toContain('aria-label="Disable raycast/run"')
	expect(html).not.toContain('package-webhook-approve')
	expect(html).not.toContain('Needs approval')
})

test('rotate keeps the Approve link on a list that lacks the approval URL', async () => {
	const unapproved = { ...run, approved: false, approvalUrl: null }
	using harness = createControllerWithFetch(({ method, body }) => {
		if (method === 'GET') {
			return { status: 200, body: listPayload([unapproved]) }
		}
		expect((body as { intent: string }).intent).toBe('rotate')
		const payload: PackageWebhooksActionPayload = {
			...listPayload([unapproved]),
			revealed: { id: run.id, handle: run.handle!, url: secretUrl },
			approvalUrl: approveUrl,
		}
		return { status: 200, body: payload }
	})
	const { controller, render } = harness
	await controller.ensureLoaded(ref)
	expect(await render()).not.toContain('package-webhook-approve')
	await controller.runIntent(ref, unapproved, { intent: 'rotate' })
	const html = await render()
	expect(html).toContain('Webhook URL rotated.')
	expect(html).toContain('you Approve it')
	expect(html).toContain(`href="${approveUrl}"`)
})

test('webhook status helpers separate unminted, needs approval, active, and disabled', () => {
	const base = { minted: true, approved: true, enabled: true }
	expect(webhookStatusLabel({ ...base, minted: false, approved: false })).toBe(
		'No URL yet',
	)
	expect(webhookStatusLabel({ ...base, approved: false })).toBe(
		'Needs approval',
	)
	expect(webhookStatusLabel(base)).toBe('Active')
	expect(webhookStatusLabel({ ...base, enabled: false })).toBe('Disabled')
	expect(webhookStatusColor({ ...base, approved: false })).toBe(
		colors.warningText,
	)
	expect(webhookSuccessMessage('mint')).not.toContain('Approve')
	expect(webhookSuccessMessage('mint', approveUrl)).toContain('Approve')
	expect(webhookSuccessMessage('rotate', approveUrl)).toContain('Approve')
	expect(webhookSuccessMessage('enable', approveUrl)).toBe('Webhook enabled.')
})
