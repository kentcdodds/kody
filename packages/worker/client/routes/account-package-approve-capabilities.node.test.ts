import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountPackageApproveCapabilitiesRoute } from '#client/routes/account-package-approve-capabilities.tsx'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'

const approveHref = '/@kody/mau-chart/approve-capabilities'
const packageId = 'ae81fd4e-7c1b-4b8e-9d0a-6f2b1c3d4e5f'
const dependencyPackageId = '0f1e2d3c-4b5a-4968-8776-655443322110'
const credentialId = 'cred_7d3f9a21b4c8'
const publishedCommit = '34f338c19f91c698c3a28edd2992e0ab87dcb4e0'
const fingerprint =
	'9b2c4e6f8a1d3c5e7f9b2d4f6a8c1e3f5a7b9d2c4e6f8a1b3d5f7a9c2e4b6d8f'

function loaderData(
	overrides: Partial<AccountPackageApproveCapabilitiesLoaderData> = {},
): AccountPackageApproveCapabilitiesLoaderData {
	return {
		ok: true,
		pendingApprovals: [],
		email: 'kody@example.com',
		package: {
			id: packageId,
			name: '@kody/mau-chart',
			kodyId: 'mau-chart',
			sourceId: 'source-1',
			hasApp: true,
			isInternetVisible: false,
		},
		publishedCommit,
		fingerprint,
		entries: [
			{
				kind: 'credential',
				credentialId,
				name: 'FATHOM_API_KEY',
				credentialKind: 'secret',
				hosts: ['api.usefathom.com'],
				placement: null,
				via: ['mau-chart'],
			},
			{
				kind: 'storage',
				storageId: packageId,
				hosts: [],
				via: ['mau-chart'],
			},
			{
				kind: 'storage',
				storageId: dependencyPackageId,
				hosts: [],
				via: ['mau-chart', 'chart-kit'],
			},
		],
		fingerprintMatchesApproval: false,
		latestApprovedAt: null,
		settingsHref: '/@kody/mau-chart/settings',
		packageHref: '/@kody/mau-chart',
		approveHref,
		...overrides,
	}
}

async function render(data: AccountPackageApproveCapabilitiesLoaderData) {
	return renderToString(
		jsx(RouterLocationProvider, {
			url: approveHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: { accountPackageApproveCapabilities: data },
				children: jsx(AccountPackageApproveCapabilitiesRoute, {}),
			}),
		}),
	)
}

function beforeDetails(html: string) {
	const index = html.indexOf(
		'data-testid="package-approve-capabilities-details"',
	)
	expect(index).toBeGreaterThan(-1)
	return html.slice(0, index)
}

test('capability approval leads with the package, credentials, and other capabilities in plain language', async () => {
	const html = await render(loaderData())

	expect(html).toContain('Approve internet-visible capabilities')
	expect(html).toContain('data-testid="package-approve-capabilities-package"')
	expect(html).toContain('@kody/mau-chart')
	// No workspace rail on the focused page.
	expect(html).not.toMatch(/<[a-z]+\s[^>]*data-account-nav[\s>=]/)
	expect(html).not.toContain('aria-label="Workspace sections"')

	expect(html).toContain('>Credentials<')
	expect(html).toContain('FATHOM_API_KEY')
	expect(html).toContain('Key · used by this package')
	expect(html).toContain('Can only be sent to api.usefathom.com')

	expect(html).toContain('>Other capabilities<')
	expect(html).toContain('>Package storage<')
	expect(html).toContain('This package can save and read its own data.')
	expect(html).toContain(
		'Its dependency chart-kit can save and read its own data.',
	)

	expect(html).toContain('Approve capability set')
	expect(html).toContain('data-testid="package-approve-capabilities-back"')
	expect(html).toContain('Back to package settings')
})

test('capability approval hides raw ids in a collapsed Details disclosure and drops the slug', async () => {
	const html = await render(loaderData())
	const main = beforeDetails(html)

	for (const id of [
		publishedCommit,
		fingerprint,
		credentialId,
		packageId,
		dependencyPackageId,
	]) {
		expect(main).not.toContain(id)
	}
	expect(html).not.toContain('>Slug<')
	expect(html).not.toContain('package slug')

	const details = html.slice(
		html.indexOf('data-testid="package-approve-capabilities-details"'),
	)
	// Collapsed by default.
	expect(details).toMatch(
		/^data-testid="package-approve-capabilities-details"[^>]*>/,
	)
	expect(details.slice(0, details.indexOf('>'))).not.toContain(' open')
	expect(details).toContain('<summary>Details</summary>')
	for (const id of [
		publishedCommit,
		fingerprint,
		credentialId,
		packageId,
		dependencyPackageId,
	]) {
		expect(details).toContain(id)
	}
	expect(details).toContain('aria-label="Copy published commit"')
	expect(details).toContain('aria-label="Copy fingerprint"')
	expect(details).toContain('aria-label="Copy FATHOM_API_KEY credential ID"')
	expect(details).toContain('aria-label="Copy Package storage ID"')
	expect(details).toContain('aria-label="Copy Package storage ID (chart-kit)"')
})

test('pending approvals keep their commit in a Details disclosure', async () => {
	const pendingCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const html = await render(
		loaderData({
			pendingApprovals: [
				{
					id: 'req-1',
					reason: 'went_public',
					reasonLabel: 'Went internet-visible',
					pendingCommit,
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: [],
					approveAction: 'approve-went-public',
				},
			],
		}),
	)

	expect(html).toContain('Waiting for your approval')
	expect(html).toContain('Approve and make internet-visible')
	const card = html.slice(
		html.indexOf('data-testid="package-pending-approval"'),
		html.indexOf('data-testid="package-pending-approval-approve"'),
	)
	const detailsIndex = card.indexOf('<summary>Details</summary>')
	expect(detailsIndex).toBeGreaterThan(-1)
	expect(card.slice(0, detailsIndex)).not.toContain(pendingCommit)
	expect(card.slice(detailsIndex)).toContain(pendingCommit)
})

test('capability approval does not claim a dependency-reached credential is dependency-only', async () => {
	const html = await render(
		loaderData({
			entries: [
				{
					kind: 'credential',
					credentialId,
					name: 'SLACK_WEBHOOK_URL',
					credentialKind: 'url',
					hosts: ['hooks.slack.com'],
					placement: null,
					via: ['mau-chart', 'slack-notify'],
				},
			],
		}),
	)

	expect(html).toContain('URL · reachable through its dependency slack-notify')
	expect(html).not.toContain('used by this package')
})

test('capability approval copy matches an already internet-visible package', async () => {
	const live = await render(
		loaderData({
			package: { ...loaderData().package, isInternetVisible: true },
		}),
	)
	expect(live).toContain(
		'@kody/mau-chart is served on the public internet. Check what it can use before you re-approve.',
	)
	expect(live).toContain(
		'It is internet-visible, so requests from anyone can run code that uses these.',
	)
	expect(live).toContain('Re-approve capability set')
	expect(live).toContain('Credential values never appear here.')
	expect(live).not.toContain('Secret values')
	expect(live).not.toContain('Before @kody/mau-chart is served')
	expect(live).not.toContain('Once it is internet-visible')

	const notLive = await render(loaderData())
	expect(notLive).toContain(
		'Before @kody/mau-chart is served on the public internet',
	)
	expect(notLive).toContain('Once it is internet-visible')
	expect(notLive).toContain('Credential values never appear here.')
	expect(notLive).not.toContain('Secret values')
})

test('a credential-needs-only approval states the change and never claims public visibility', async () => {
	const pendingCommit = 'e650a38aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const html = await render(
		loaderData({
			package: {
				...loaderData().package,
				name: '@kentcdodds/nextdns',
				kodyId: 'nextdns',
				hasApp: false,
				isInternetVisible: false,
			},
			pendingApprovals: [
				{
					id: 'req-cred-1',
					reason: 'credential_needs_changed',
					reasonLabel: 'Credential needs changed',
					pendingCommit,
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: [
						'This version adds a credential need: NEXTDNS_API_KEY from nextdns',
					],
					approveAction: 'approve-credential-needs',
				},
			],
		}),
	)

	expect(html).toContain('Approve credential needs')
	expect(html).toContain(
		'This version adds a credential need: NEXTDNS_API_KEY from nextdns',
	)
	expect(html).toContain(
		'The previously published version keeps running until you approve.',
	)
	expect(html).toContain('Credential values never appear here.')
	expect(html).toContain('This publish asks to use these credentials.')
	expect(html).toContain('Approve and publish')

	expect(html).not.toContain('Approve internet-visible capabilities')
	expect(html).not.toContain('public internet')
	expect(html).not.toContain('internet-visible')
	expect(html).not.toContain('Once it is internet-visible')
	expect(html).not.toContain('Secret values')
	expect(html).not.toContain('Approve and make internet-visible')

	const card = html.slice(
		html.indexOf('data-testid="package-pending-approval"'),
		html.indexOf('data-testid="package-pending-approval-approve"'),
	)
	const detailsIndex = card.indexOf('<summary>Details</summary>')
	expect(detailsIndex).toBeGreaterThan(-1)
	expect(card.slice(0, detailsIndex)).not.toContain(pendingCommit)
	expect(card.slice(detailsIndex)).toContain(pendingCommit)
})

test('a went_public pending approval still mentions internet visibility', async () => {
	const html = await render(
		loaderData({
			pendingApprovals: [
				{
					id: 'req-1',
					reason: 'went_public',
					reasonLabel: 'Went internet-visible',
					pendingCommit: 'cccccccccccccccccccccccccccccccccccccccc',
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: ['Serve this package on the public internet.'],
					approveAction: 'approve-went-public',
				},
			],
		}),
	)

	expect(html).toContain('Approve package changes')
	expect(html).toContain(
		'Approving turns on internet-visible serving for this package.',
	)
	expect(html).toContain(
		'Internet-visible serving stays off until you approve.',
	)
	expect(html).toContain('Approve and make internet-visible')
	expect(html).toContain('Once it is internet-visible')
})

test('capability approval says so plainly when nothing is reachable', async () => {
	const html = await render(loaderData({ entries: [] }))

	expect(html).toContain('This package does not use any of your credentials.')
	expect(html).toContain('No other capabilities.')
})
