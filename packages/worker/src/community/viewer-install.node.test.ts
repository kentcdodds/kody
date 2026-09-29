import { expect, test } from 'vitest'
import { resolveViewerListingInstalls } from './viewer-install.ts'

type ResolveInput = Parameters<typeof resolveViewerListingInstalls>[0]
type Fork = ResolveInput['forks'][number]

function fork(
	listingId: string,
	targetKodyId: string,
	forkedPackageId: string,
	forkedSourceId: string,
	createdAt: string,
	originCommit?: string,
): Fork {
	return {
		listingId,
		targetKodyId,
		forkedPackageId,
		forkedSourceId,
		createdAt,
		...(originCommit ? { originCommit } : {}),
	}
}

function install(
	targetKodyId: string,
	sourceId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		status: 'installed',
		targetName: `@burhan/${targetKodyId}`,
		sourceId,
		packageId: null,
		listingAhead: false,
		forkAhead: false,
		originCommit: null,
		listingPinnedCommit: null,
		...overrides,
	}
}

const githubPackage = {
	id: 'pkg-github',
	kodyId: 'github',
	name: '@burhan/github',
	sourceId: 'src-github',
}

test('resolveViewerListingInstalls prefers kody matches, then forks, and classifies outdated vs ahead from ancestry', () => {
	const resolved = resolveViewerListingInstalls({
		listings: ['github', 'cloudflare', 'notion', 'slack', 'dropbox'].map(
			(kodyId) => ({ id: `listing-${kodyId}`, kodyId }),
		),
		packageScope: 'burhan',
		savedPackages: [
			githubPackage,
			{
				id: 'pkg-notion-custom',
				kodyId: 'my-notion',
				name: '@burhan/my-notion',
				sourceId: 'src-notion',
			},
		],
		forks: [
			fork(
				'listing-cloudflare',
				'cloudflare',
				'pkg-cf-inert',
				'src-cf',
				'2026-08-01T00:00:00.000Z',
			),
			fork(
				'listing-notion',
				'my-notion',
				'pkg-notion-custom',
				'src-notion',
				'2026-08-02T00:00:00.000Z',
			),
			fork(
				'listing-notion',
				'older-notion',
				'pkg-notion-old',
				'src-notion-old',
				'2026-07-01T00:00:00.000Z',
			),
			fork(
				'listing-dropbox',
				'older-dropbox',
				'pkg-dropbox-old',
				'src-dropbox-old',
				'2026-06-01T00:00:00.000Z',
			),
			fork(
				'listing-dropbox',
				'my-dropbox',
				'pkg-dropbox-new',
				'src-dropbox-new',
				'2026-08-03T00:00:00.000Z',
			),
		],
	})
	expect(Object.fromEntries(resolved)).toEqual({
		'listing-github': install('github', 'src-github', {
			packageId: 'pkg-github',
		}),
		'listing-cloudflare': install('cloudflare', 'src-cf', {
			status: 'adaptation_required',
		}),
		'listing-notion': install('my-notion', 'src-notion', {
			packageId: 'pkg-notion-custom',
		}),
		'listing-dropbox': install('my-dropbox', 'src-dropbox-new', {
			status: 'adaptation_required',
		}),
	})

	const githubCases: Array<{
		name: string
		pinnedCommit: string
		fork: Fork
		pinIsAncestor?: boolean
		expected: Record<string, unknown>
	}> = [
		{
			name: 'outdated',
			pinnedCommit: 'commit-new',
			fork: fork(
				'listing-github',
				'github',
				'pkg-github',
				'src-github',
				'2026-08-01T00:00:00.000Z',
				'commit-old',
			),
			pinIsAncestor: false,
			expected: { listingAhead: true, originCommit: 'commit-old' },
		},
		{
			name: 'ahead',
			pinnedCommit: 'commit-pin',
			fork: fork(
				'listing-github',
				'github',
				'pkg-github',
				'src-github',
				'2026-08-01T00:00:00.000Z',
				'commit-tip',
			),
			pinIsAncestor: true,
			expected: { forkAhead: true, originCommit: 'commit-tip' },
		},
		{
			name: 'self-authored',
			pinnedCommit: 'commit-new',
			fork: fork(
				'listing-github',
				'github-custom',
				'pkg-github-custom',
				'src-github-custom',
				'2026-08-02T00:00:00.000Z',
				'commit-old',
			),
			expected: {},
		},
	]
	for (const {
		name,
		pinnedCommit,
		fork: githubFork,
		pinIsAncestor,
		expected,
	} of githubCases) {
		const githubResolved = resolveViewerListingInstalls({
			listings: [{ id: 'listing-github', kodyId: 'github', pinnedCommit }],
			packageScope: 'burhan',
			savedPackages: [githubPackage],
			forks: [githubFork],
			...(pinIsAncestor === undefined
				? {}
				: {
						listingPinIsAncestorByListingId: new Map([
							['listing-github', pinIsAncestor],
						]),
					}),
		})
		expect({ name, install: githubResolved.get('listing-github') }).toEqual({
			name,
			install: install('github', 'src-github', {
				packageId: 'pkg-github',
				listingPinnedCommit: pinnedCommit,
				...expected,
			}),
		})
	}
})
