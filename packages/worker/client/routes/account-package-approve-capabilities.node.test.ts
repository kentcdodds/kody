import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountPackageApproveCapabilitiesRoute } from '#client/routes/account-package-approve-capabilities.tsx'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'
import { buildPackageSecurityAuditPrompt } from '#universal/package-security-audit-prompt.ts'

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
		securityAudit: {
			status: 'not_audited',
			prompt: buildPackageSecurityAuditPrompt({
				packageName: '@kody/mau-chart',
				packageId,
				publishedCommit,
				fingerprint,
				approvalUrl: `https://kody.codes${approveHref}`,
			}),
		},
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

/** Visible page text: everything before Details, minus closed dialogs. */
function beforeDetails(html: string) {
	const index = html.indexOf(
		'data-testid="package-approve-capabilities-details"',
	)
	expect(index).toBeGreaterThan(-1)
	return withoutDialogs(html.slice(0, index))
}

function withoutDialogs(html: string) {
	return html.replace(/<dialog[\s\S]*?<\/dialog>/g, '')
}

function securityAuditField(html: string) {
	const start = html.indexOf('data-testid="package-security-audit"')
	expect(start).toBeGreaterThan(-1)
	return html.slice(start, html.indexOf('</section>', start))
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
	expect(live).not.toContain('Before @kody/mau-chart is served')
	expect(live).not.toContain('Once it is internet-visible')

	const notLive = await render(loaderData())
	expect(notLive).toContain(
		'Before @kody/mau-chart is served on the public internet',
	)
	expect(notLive).toContain('Once it is internet-visible')
})

test('capability approval says so plainly when nothing is reachable', async () => {
	const html = await render(loaderData({ entries: [] }))

	expect(html).toContain('This package does not use any of your credentials.')
	expect(html).toContain('No other capabilities.')
})

test('security audit reads "No security audit performed" and offers a copyable agent prompt', async () => {
	const html = await render(loaderData())
	const field = securityAuditField(html)

	expect(field).toContain('data-audit-status="not_audited"')
	expect(field).toContain('>Security audit<')
	expect(field).toContain('No security audit performed')
	expect(field).toContain('aria-haspopup="dialog"')
	expect(field).toContain('Ask your agent for a security audit')

	const prompt = field.slice(
		field.indexOf('data-testid="package-security-audit-prompt"'),
	)
	for (const value of [packageId, publishedCommit, fingerprint]) {
		expect(prompt).toContain(value)
	}
	expect(prompt).toContain('packageSecurityAuditRecord')
	expect(field).toContain('aria-label="Copy security audit prompt"')
	expect(withoutDialogs(field)).not.toContain(publishedCommit)

	// Informational only: Approve stays its own button.
	expect(html).toContain('data-testid="package-approve-capabilities"')
	expect(field).not.toContain('data-testid="package-approve-capabilities"')
})

test('security audit shows who audited when, with a link to the summary', async () => {
	const html = await render(
		loaderData({
			securityAudit: {
				status: 'audited',
				verdict: 'concerns',
				summary: 'FATHOM_API_KEY is only sent to api.usefathom.com.',
				auditor: 'Audit Agent',
				recordedBy: '@kody',
				recordedAt: '2026-10-14T15:30:00.000Z',
			},
		}),
	)
	const field = securityAuditField(html)

	expect(field).toContain('data-audit-status="audited"')
	expect(field).toMatch(/Audited [^<]+ by Audit Agent/)
	expect(field).toContain('href="#security-audit"')
	expect(field).toContain('>Concerns<')
	expect(field).toContain('Security audit summary')
	expect(field).toContain('recorded by @kody')
	expect(field).toContain('FATHOM_API_KEY is only sent to api.usefathom.com.')
	expect(field).not.toContain('No security audit performed')
	expect(field).not.toContain(publishedCommit)
})

test('security audit asks for a publish before an unpublished package can be audited', async () => {
	const html = await render(
		loaderData({
			publishedCommit: null,
			securityAudit: { status: 'unpublished' },
		}),
	)
	const field = securityAuditField(html)

	expect(field).toContain(
		'No security audit performed. Publish this package to audit it.',
	)
	expect(field).not.toContain('<dialog')
})

test('security audit says it does not cover a paused publish waiting on the page', async () => {
	const paused = await render(
		loaderData({
			pendingApprovals: [
				{
					id: 'req-2',
					reason: 'credential_needs_changed',
					reasonLabel: 'Credential needs changed',
					pendingCommit: 'cccccccccccccccccccccccccccccccccccccccc',
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: [],
					approveAction: 'approve-credential-needs',
				},
			],
		}),
	)
	expect(securityAuditField(paused)).toContain(
		'Covers the published version only, not the paused publish waiting',
	)

	expect(securityAuditField(await render(loaderData()))).not.toContain(
		'data-testid="package-security-audit-paused-note"',
	)
})
