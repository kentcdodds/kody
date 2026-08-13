import { expect, test } from 'vitest'
import { resolveViewerListingInstalls } from './viewer-install.ts'

test('resolveViewerListingInstalls prefers matching kody_id, then listing forks', () => {
	const listings = [
		{ id: 'listing-github', kodyId: 'github' },
		{ id: 'listing-cloudflare', kodyId: 'cloudflare' },
		{ id: 'listing-notion', kodyId: 'notion' },
		{ id: 'listing-slack', kodyId: 'slack' },
		{ id: 'listing-dropbox', kodyId: 'dropbox' },
	]

	const resolved = resolveViewerListingInstalls({
		listings,
		packageScope: 'burhan',
		savedPackages: [
			{
				id: 'pkg-github',
				kodyId: 'github',
				name: '@burhan/github',
				sourceId: 'src-github',
			},
			{
				id: 'pkg-notion-custom',
				kodyId: 'my-notion',
				name: '@burhan/my-notion',
				sourceId: 'src-notion',
			},
		],
		forks: [
			{
				listingId: 'listing-cloudflare',
				targetKodyId: 'cloudflare',
				forkedPackageId: 'pkg-cf-inert',
				forkedSourceId: 'src-cf',
				createdAt: '2026-08-01T00:00:00.000Z',
			},
			{
				listingId: 'listing-notion',
				targetKodyId: 'my-notion',
				forkedPackageId: 'pkg-notion-custom',
				forkedSourceId: 'src-notion',
				createdAt: '2026-08-02T00:00:00.000Z',
			},
			{
				listingId: 'listing-notion',
				targetKodyId: 'older-notion',
				forkedPackageId: 'pkg-notion-old',
				forkedSourceId: 'src-notion-old',
				createdAt: '2026-07-01T00:00:00.000Z',
			},
			{
				listingId: 'listing-dropbox',
				targetKodyId: 'older-dropbox',
				forkedPackageId: 'pkg-dropbox-old',
				forkedSourceId: 'src-dropbox-old',
				createdAt: '2026-06-01T00:00:00.000Z',
			},
			{
				listingId: 'listing-dropbox',
				targetKodyId: 'my-dropbox',
				forkedPackageId: 'pkg-dropbox-new',
				forkedSourceId: 'src-dropbox-new',
				createdAt: '2026-08-03T00:00:00.000Z',
			},
		],
	})

	expect(resolved.get('listing-github')).toEqual({
		status: 'installed',
		targetName: '@burhan/github',
		sourceId: 'src-github',
		packageId: 'pkg-github',
	})
	expect(resolved.get('listing-cloudflare')).toEqual({
		status: 'adaptation_required',
		targetName: '@burhan/cloudflare',
		sourceId: 'src-cf',
		packageId: null,
	})
	expect(resolved.get('listing-notion')).toEqual({
		status: 'installed',
		targetName: '@burhan/my-notion',
		sourceId: 'src-notion',
		packageId: 'pkg-notion-custom',
	})
	expect(resolved.has('listing-slack')).toBe(false)
	expect(resolved.get('listing-dropbox')).toEqual({
		status: 'adaptation_required',
		targetName: '@burhan/my-dropbox',
		sourceId: 'src-dropbox-new',
		packageId: null,
	})
})
