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

test('resolveViewerListingInstalls requires a fork row; same-leaf alone is not installed', () => {
	const resolved = resolveViewerListingInstalls({
		listings: [
			'github',
			'cloudflare',
			'notion',
			'slack',
			'dropbox',
			'discord',
		].map((kodyId) => ({ id: `listing-${kodyId}`, kodyId })),
		packageScope: 'burhan',
		savedPackages: [
			githubPackage,
			{
				id: 'pkg-notion-custom',
				kodyId: 'my-notion',
				name: '@burhan/my-notion',
				sourceId: 'src-notion',
			},
			{
				id: 'pkg-discord-own',
				kodyId: 'discord',
				name: '@burhan/discord',
				sourceId: 'src-discord-own',
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
			fork(
				'listing-github',
				'github',
				'pkg-github',
				'src-github',
				'2026-08-01T00:00:00.000Z',
				'commit-same',
			),
		],
	})
	expect(Object.fromEntries(resolved)).toEqual({
		'listing-github': install('github', 'src-github', {
			packageId: 'pkg-github',
			originCommit: 'commit-same',
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
	expect(resolved.has('listing-discord')).toBe(false)
	expect(resolved.has('listing-slack')).toBe(false)

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
			name: 'renamed-fork-wins-over-same-leaf-non-fork',
			pinnedCommit: 'commit-new',
			fork: fork(
				'listing-github',
				'github-custom',
				'pkg-github-custom',
				'src-github-custom',
				'2026-08-02T00:00:00.000Z',
				'commit-old',
			),
			expected: {
				status: 'adaptation_required',
				targetName: '@burhan/github-custom',
				sourceId: 'src-github-custom',
				packageId: null,
				forkAhead: true,
				originCommit: 'commit-old',
			},
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

test('same-leaf package without fork is not installed; real fork of listing is', () => {
	const listingId = 'listing-discord'
	const listing = { id: listingId, kodyId: 'discord', pinnedCommit: 'pin-1' }
	const sameLeafOwn = {
		id: 'pkg-own-discord',
		kodyId: 'discord',
		name: '@jelias/discord',
		sourceId: 'src-own-discord',
	}
	const forkedInstall = {
		id: 'pkg-forked-discord',
		kodyId: 'discord',
		name: '@jelias/discord-from-community',
		sourceId: 'src-forked-discord',
	}

	const withoutFork = resolveViewerListingInstalls({
		listings: [listing],
		packageScope: 'jelias',
		savedPackages: [sameLeafOwn],
		forks: [],
	})
	expect(withoutFork.has(listingId)).toBe(false)

	const withFork = resolveViewerListingInstalls({
		listings: [listing],
		packageScope: 'jelias',
		savedPackages: [sameLeafOwn, forkedInstall],
		forks: [
			fork(
				listingId,
				'discord',
				forkedInstall.id,
				forkedInstall.sourceId,
				'2026-08-01T00:00:00.000Z',
				'pin-1',
			),
		],
	})
	expect(withFork.get(listingId)).toEqual({
		status: 'installed',
		targetName: forkedInstall.name,
		sourceId: forkedInstall.sourceId,
		packageId: forkedInstall.id,
		listingAhead: false,
		forkAhead: false,
		originCommit: 'pin-1',
		listingPinnedCommit: 'pin-1',
	})
})
