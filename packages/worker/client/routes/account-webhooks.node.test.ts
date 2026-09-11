import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountWebhooksRoute } from '#client/routes/account-webhooks.tsx'
import {
	buildWebhookDetailHref,
	readWebhookSelection,
	webhookStatusLabel,
} from '#client/routes/account-webhooks-shared.ts'
import { type SessionInfo } from '#client/session.ts'
import {
	type AccountWebhookListItem,
	type AccountWebhooksLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'

const session: SessionInfo = {
	email: 'jane@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'jane',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

const unminted: AccountWebhookListItem = {
	id: 'sentry-bridge/sentry',
	packageId: 'pkg-1',
	packageKodyId: 'sentry-bridge',
	packageName: '@jane/sentry-bridge',
	name: 'sentry',
	exportName: './handle-sentry-webhook',
	description: 'Forward Sentry alerts into automations',
	responseMode: 'ack',
	inputMode: 'request',
	rateLimitPerMinute: 60,
	verification: {
		type: 'hmac-sha256',
		header: 'sentry-hook-signature',
		secretName: 'sentryWebhookSecret',
		encoding: 'hex',
	},
	replay: null,
	minted: false,
	handle: null,
	urlHost: null,
	enabled: null,
	urlRecoverable: false,
	createdAt: null,
	rotatedAt: null,
}

const minted: AccountWebhookListItem = {
	id: 'raycast-bridge/launch',
	packageId: 'pkg-2',
	packageKodyId: 'raycast-bridge',
	packageName: '@jane/raycast-bridge',
	name: 'launch',
	exportName: './dispatch-launch',
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

function renderWebhooksPage(
	url: string,
	accountWebhooks: AccountWebhooksLoaderData,
) {
	return renderToString(
		jsx(RouterLocationProvider, {
			url,
			children: jsx(AppSessionProvider, {
				session,
				status: 'ready',
				children: jsx(AppLoaderDataProvider, {
					loaderData: { accountWebhooks },
					children: jsx(AccountWebhooksRoute, {}),
				}),
			}),
		}),
	)
}

const payload: AccountWebhooksLoaderData = {
	ok: true,
	username: 'jane',
	webhooks: [minted, unminted],
}

test('webhooks page lists declared webhooks with status and links each row to its detail route', async () => {
	const html = await renderWebhooksPage(routes.accountWebhooks.href(), payload)

	expect(html).toContain('>Webhooks</h1>')
	expect(html).toContain('aria-label="Webhooks"')
	expect(html).toContain('2 declared · 1 minted')
	expect(html).toContain(`href="${buildWebhookDetailHref(minted)}"`)
	expect(html).toContain(`href="${buildWebhookDetailHref(unminted)}"`)
	expect(html).toContain('>Active<')
	expect(html).toContain('>No URL yet<')
	expect(html).toContain('URL secret only')
	expect(html).toContain('hmac-sha256 · sentry-hook-signature')
	// The rail marks this page current; no cold-path loading copy with SSR data.
	expect(html).toMatch(/href="\/account\/webhooks"[^>]*aria-current="page"/)
	expect(html).not.toContain('Loading webhooks')
	// Nothing on the list page resembles a credential path.
	expect(html).not.toContain('/@jane/webhooks/')
})

test('webhooks detail offers Mint for an unminted webhook and Reveal, Rotate, and Disable for a minted one — never the URL itself', async () => {
	const unmintedHtml = await renderWebhooksPage(
		buildWebhookDetailHref(unminted),
		payload,
	)
	expect(unmintedHtml).toContain('data-webhook-id="sentry-bridge/sentry"')
	expect(unmintedHtml).toContain('data-testid="account-webhook-mint"')
	expect(unmintedHtml).toContain('Forward Sentry alerts into automations')
	expect(unmintedHtml).toContain('secret <code>sentryWebhookSecret</code>')
	expect(unmintedHtml).not.toContain('data-testid="account-webhook-reveal"')
	expect(unmintedHtml).not.toContain('Rotate URL')

	const mintedHtml = await renderWebhooksPage(
		buildWebhookDetailHref(minted),
		payload,
	)
	expect(mintedHtml).toContain('data-webhook-id="raycast-bridge/launch"')
	expect(mintedHtml).toContain('data-testid="account-webhook-reveal"')
	expect(mintedHtml).toContain(
		'aria-label="Rotate URL for raycast-bridge/launch"',
	)
	expect(mintedHtml).toContain('aria-label="Disable raycast-bridge/launch"')
	expect(mintedHtml).toContain('whh_11111111-1111-1111-1111-111111111111')
	expect(mintedHtml).toContain('600 / min')
	expect(mintedHtml).toContain('delivery id X-Delivery-Id')
	expect(mintedHtml).toContain('surface=webhook')
	expect(mintedHtml).not.toContain('data-testid="account-webhook-mint"')
	// The credential is fetched on Reveal, so SSR HTML has no URL to embed.
	expect(mintedHtml).not.toContain('Copy webhook URL')
	expect(mintedHtml).not.toContain('/@jane/webhooks/')
})

test('webhooks detail points legacy mints at Rotate instead of Reveal', async () => {
	const legacy: AccountWebhookListItem = {
		...minted,
		urlRecoverable: false,
		enabled: false,
	}
	const html = await renderWebhooksPage(buildWebhookDetailHref(legacy), {
		...payload,
		webhooks: [legacy, unminted],
	})
	expect(html).not.toContain('data-testid="account-webhook-reveal"')
	expect(html).toContain('Rotate it to get a URL you can copy')
	expect(html).toContain('aria-label="Enable raycast-bridge/launch"')
	expect(html).toContain('>Disabled<')
})

test('webhooks detail route renders a not-found record for an undeclared webhook', async () => {
	const html = await renderWebhooksPage(
		routes.accountWebhookDetail.href({
			packageKodyId: 'sentry-bridge',
			webhookName: 'missing',
		}),
		payload,
	)
	expect(html).toContain('Webhook not found')
})

test('webhook selection round-trips through the two-segment detail route', () => {
	expect(readWebhookSelection('/account/webhooks')).toBeNull()
	expect(readWebhookSelection('/account/webhooks/only-one')).toBeNull()
	expect(readWebhookSelection('/account/webhooks/a/b/c')).toBeNull()
	expect(readWebhookSelection(buildWebhookDetailHref(minted))).toBe(minted.id)
	expect(
		readWebhookSelection(
			buildWebhookDetailHref({ packageKodyId: 'my.pkg', name: 'hook' }),
		),
	).toBe('my.pkg/hook')
	expect(webhookStatusLabel({ minted: false, enabled: null })).toBe(
		'No URL yet',
	)
	expect(webhookStatusLabel({ minted: true, enabled: false })).toBe('Disabled')
})
