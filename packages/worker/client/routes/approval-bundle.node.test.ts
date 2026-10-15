import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { afterEach, expect, test, vi } from 'vitest'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { ApprovalBundleRoute, loadApprovalBundle } from './approval-bundle.tsx'
import {
	type ApprovalBundleLoaderData,
	type ApprovalBundleView,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'

const href = '/@acme/-/approvals/bundle-1'
const signal = new AbortController().signal
const pausedCommit = 'e650a38bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function respond(body: unknown, status: number) {
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify(body), { status }),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('the bundle loads from its JSON API', async () => {
	const view = { ok: true, bundle: { id: 'bundle-1' }, groups: [] }
	const fetchMock = respond(view, 200)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'data',
		data: { ok: true, view },
	})
	expect(fetchMock).toHaveBeenCalledWith(
		'/@acme/-/approvals/bundle-1.json',
		expect.objectContaining({ credentials: 'include' }),
	)
})

test('signed-out viewers log in and come back to the bundle', async () => {
	respond({ ok: false }, 401)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'redirect',
		to: `/login?redirectTo=${encodeURIComponent(href)}`,
	})
})

test('someone else’s bundle is not found, and an old one is expired', async () => {
	respond({ ok: false }, 404)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'data',
		data: { ok: false, reason: 'not-found' },
	})
	respond({ ok: false, reason: 'expired' }, 410)
	expect(await loadApprovalBundle(href, signal)).toEqual({
		kind: 'data',
		data: { ok: false, reason: 'expired' },
	})
})

test('other failures throw', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('<html></html>', { status: 500 })),
	)
	await expect(loadApprovalBundle(href, signal)).rejects.toThrow(
		'Kody could not load these approvals (HTTP 500).',
	)
})

function credentialNeedsItem(
	overrides: Partial<ApprovalItemView> = {},
): ApprovalItemView {
	return {
		key: 'publish:req-1',
		type: 'publish',
		title: 'Publish with changed credential needs',
		summary:
			'Approving publishes this version, which asks for the credentials below. The previously published version keeps serving until you approve. Denying drops this paused publish.',
		package: {
			id: 'pkg-1',
			kodyId: 'nextdns',
			name: '@kentcdodds/nextdns',
			href: '/@kentcdodds/nextdns',
		},
		status: 'pending',
		statusMessage: null,
		canApprove: true,
		canDeny: true,
		fingerprint: pausedCommit,
		detailLabel: 'Paused commit',
		grants: [
			{
				change: 'added',
				label: 'NEXTDNS_API_KEY',
				where: null,
				kind: 'Key',
				provider: 'nextdns',
				hosts: ['api.nextdns.io'],
				before: null,
				after: 'Key from provider "nextdns"',
				match:
					'No credential of yours matches yet; runs fail until you add one.',
			},
		],
		reviewHref: '/@kentcdodds/nextdns/approve-capabilities',
		decision: null,
		...overrides,
	}
}

function bundleLoaderData(
	item: ApprovalItemView = credentialNeedsItem(),
): ApprovalBundleLoaderData {
	const view: ApprovalBundleView = {
		ok: true,
		bundle: {
			id: 'bundle-1',
			orgSlug: 'acme',
			createdAt: '2026-10-14T00:00:00.000Z',
			expiresAt: '2026-11-13T00:00:00.000Z',
			note: null,
			createdVia: 'CLI',
		},
		groups: [
			{
				package: item.package,
				items: [item],
			},
		],
	}
	return { ok: true, view }
}

async function renderBundle(data: ApprovalBundleLoaderData) {
	return renderToString(
		jsx(RouterLocationProvider, {
			url: href,
			children: jsx(AppLoaderDataProvider, {
				loaderData: { approvalBundle: data },
				children: jsx(ApprovalBundleRoute, {}),
			}),
		}),
	)
}

test('a credential-needs-only bundle item states the credential change and hides the commit behind Details', async () => {
	const html = await renderBundle(bundleLoaderData())

	expect(html).toContain('1 change waits for you')
	expect(html).toContain('Publish with changed credential needs')
	expect(html).toContain(
		'Approving publishes this version, which asks for the credentials below.',
	)
	expect(html).toContain('NEXTDNS_API_KEY')
	expect(html).toContain('provider nextdns')
	expect(html).toContain('Credential values are never shown.')

	const item = html.slice(html.indexOf('data-testid="approval-bundle-item"'))
	const detailsIndex = item.indexOf(
		'data-testid="approval-bundle-item-details"',
	)
	expect(detailsIndex).toBeGreaterThan(-1)
	const beforeDetails = item.slice(0, detailsIndex)
	expect(beforeDetails).not.toContain(pausedCommit)
	expect(beforeDetails).not.toContain(pausedCommit.slice(0, 7))
	const details = item.slice(detailsIndex)
	expect(details).toContain(pausedCommit)
	expect(details).toContain('<summary>Details</summary>')
	expect(details.slice(0, details.indexOf('>'))).not.toContain(' open')
})

test('a went_public bundle item still mentions public internet visibility', async () => {
	const html = await renderBundle(
		bundleLoaderData(
			credentialNeedsItem({
				title: 'Serve on the public internet',
				detailLabel: 'Published commit',
				summary:
					'Serve this package on the public internet. Approving turns on internet-visible serving for this version. Denying leaves it off.',
				grants: [
					{
						change: 'added',
						label: 'Public internet',
						where: null,
						kind: null,
						provider: null,
						hosts: [],
						before: 'Not internet-visible',
						after: 'Anyone on the internet can reach this package’s app',
						match: null,
					},
				],
			}),
		),
	)

	expect(html).toContain('Serve on the public internet')
	expect(html).toContain('internet-visible serving')
	expect(html).toContain('Public internet')
	expect(html).toContain('Published commit')
	expect(html).not.toContain('Paused commit')
})

test('credential-picks Details label the approval fingerprint, not a proposal id', async () => {
	const html = await renderBundle(
		bundleLoaderData(
			credentialNeedsItem({
				key: 'credential-picks:prop-1',
				type: 'credential-picks',
				title: 'Choose credentials',
				summary: 'Approving saves these credential mappings.',
				fingerprint: 'fp-decision-abc',
				detailLabel: 'Approval fingerprint',
				grants: [],
			}),
		),
	)

	expect(html).toContain('Approval fingerprint')
	expect(html).toContain('fp-decision-abc')
	expect(html).not.toContain('Proposal id')
})
