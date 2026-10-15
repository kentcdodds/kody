import { afterEach, expect, test, vi } from 'vitest'
import { loadPackageCollaboratorsPage } from './package-collaborators-data.ts'

const detail = {
	ok: true,
	username: 'acme',
	kodyId: 'release-notes',
	isPrivate: true,
	listing: null,
	ownerProfilePublic: true,
	viewerIsOwner: true,
	viewerCanManage: true,
	viewerCanManageAccess: true,
	ownerPackage: {
		id: 'pkg-1',
		kodyId: 'release-notes',
		name: 'release-notes',
		description: 'Drafts release notes',
		isPrivate: true,
		hasCommunityListing: false,
		publishedCommit: null,
	},
}

const view = {
	ok: true,
	package: { id: 'pkg-1', kodyId: 'release-notes', name: 'release-notes' },
	org: { slug: 'acme', personal: false },
	collaborators: [],
	invites: [],
	options: { teams: [], members: [] },
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function stubFetch(responses: { detail: Response; view: Response }) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
		String(input).endsWith('/collaborators.json')
			? responses.view.clone()
			: responses.detail.clone(),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const href = '/@acme/release-notes/collaborators'
const signal = new AbortController().signal

afterEach(() => {
	vi.unstubAllGlobals()
})

test('loads the chrome and the collaborators view together', async () => {
	const fetchMock = stubFetch({ detail: json(detail), view: json(view) })
	const result = await loadPackageCollaboratorsPage(href, signal)
	expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
		'/profiles/acme/packages/release-notes.json',
		'/profiles/acme/packages/release-notes/collaborators.json',
	])
	expect(result).toEqual({
		kind: 'data',
		data: {
			ok: true,
			shell: {
				username: 'acme',
				kodyId: 'release-notes',
				name: 'release-notes',
				description: 'Drafts release notes',
				isPrivate: true,
				isListed: false,
				listingId: null,
				defaultBranch: null,
				publishedCommit: null,
				ownerProfilePublic: true,
				viewerCanManage: true,
			},
			view,
		},
	})
})

test('without Manage the tab is not found', async () => {
	stubFetch({
		detail: json(detail),
		view: json({ ok: false, error: 'You need Manage' }, 403),
	})
	expect(await loadPackageCollaboratorsPage(href, signal)).toEqual({
		kind: 'data',
		data: { ok: false, notFound: true },
	})
})

test('signed-out viewers go to login and come back to the tab', async () => {
	stubFetch({
		detail: json({ ok: false }, 401),
		view: json({ ok: false }, 401),
	})
	expect(await loadPackageCollaboratorsPage(href, signal)).toEqual({
		kind: 'redirect',
		to: `/login?redirectTo=${encodeURIComponent(href)}`,
	})
})

test('a moved package redirects to its new collaborators tab', async () => {
	stubFetch({
		detail: json({ ok: false, redirectTo: '/@acme/changelog' }, 404),
		view: json({ ok: false }, 404),
	})
	expect(await loadPackageCollaboratorsPage(href, signal)).toEqual({
		kind: 'redirect',
		to: '/@acme/changelog/collaborators',
	})
})
