import { expect, test } from 'vitest'
import {
	directoryOfPackageFilePath,
	getCommunityPackageAssetBaseHref,
	getCommunityPackageAssetBaseHrefForViewedCommit,
	getCommunityPackageAssetHref,
	packageReadmeAssetCommitMatchesView,
	isPackageReadmeImagePath,
	joinPackageReadmeImageHref,
	resolvePackageReadmeImagePath,
} from './package-readme-images.ts'

test('package README image paths stay inside the repo and reject remote hrefs', () => {
	expect(resolvePackageReadmeImagePath('./docs/poster.png')).toBe(
		'docs/poster.png',
	)
	expect(resolvePackageReadmeImagePath('docs/poster.png')).toBe(
		'docs/poster.png',
	)
	expect(resolvePackageReadmeImagePath('/docs/poster.png')).toBe(
		'docs/poster.png',
	)
	expect(resolvePackageReadmeImagePath('./poster.png', 'docs')).toBe(
		'docs/poster.png',
	)
	expect(resolvePackageReadmeImagePath('../poster.png', 'docs')).toBe(null)
	expect(resolvePackageReadmeImagePath('https://evil.example/x.png')).toBe(null)
	expect(resolvePackageReadmeImagePath('//evil.example/x.png')).toBe(null)
	expect(resolvePackageReadmeImagePath('javascript:alert(1)')).toBe(null)
	expect(resolvePackageReadmeImagePath('data:image/png;base64,aaaa')).toBe(null)
	expect(resolvePackageReadmeImagePath('./docs/poster.png?raw=1')).toBe(null)
	expect(resolvePackageReadmeImagePath('./README.md')).toBe(null)
	expect(resolvePackageReadmeImagePath('./docs/app.js')).toBe(null)
	expect(isPackageReadmeImagePath('docs/poster.png')).toBe(true)
	expect(isPackageReadmeImagePath('docs/poster.PNG')).toBe(true)
	expect(isPackageReadmeImagePath('src/index.ts')).toBe(false)
	expect(directoryOfPackageFilePath('README.md')).toBe('')
	expect(directoryOfPackageFilePath('docs/README.md')).toBe('docs')
})

test('package README asset hrefs use the third-segment noun and reserved-id fallback', () => {
	expect(
		getCommunityPackageAssetHref({
			listingId: 'listing-1',
			ownerUsername: 'kody',
			kodyId: 'doom',
			relativePath: 'docs/poster.png',
		}),
	).toBe('/@kody/doom/assets/docs/poster.png')
	expect(
		getCommunityPackageAssetBaseHref({
			ownerUsername: 'kody',
			kodyId: 'doom',
		}),
	).toBe('/@kody/doom/assets')
	expect(
		getCommunityPackageAssetHref({
			listingId: 'listing-1',
			ownerUsername: 'kody',
			kodyId: 'packages',
			relativePath: 'docs/poster.png',
		}),
	).toBe('/community/listing-1/assets/docs/poster.png')
	expect(
		getCommunityPackageAssetHref({
			ownerUsername: 'kody',
			kodyId: 'packages',
			relativePath: 'docs/poster.png',
		}),
	).toBe(null)
	expect(
		joinPackageReadmeImageHref('/@kody/doom/assets', 'docs/poster.png'),
	).toBe('/@kody/doom/assets/docs/poster.png')
})

test('package README images opt in only when the viewed commit is the asset pin', () => {
	expect(packageReadmeAssetCommitMatchesView('abc1234', 'abc1234')).toBe(true)
	expect(packageReadmeAssetCommitMatchesView('abc1234def', 'abc1234')).toBe(
		true,
	)
	expect(packageReadmeAssetCommitMatchesView('abc1234', 'abc1234def')).toBe(
		true,
	)
	expect(packageReadmeAssetCommitMatchesView('deadbeef', 'abc1234')).toBe(false)
	expect(packageReadmeAssetCommitMatchesView('', 'abc1234')).toBe(false)
	expect(packageReadmeAssetCommitMatchesView('abc1234', '')).toBe(false)
	expect(
		getCommunityPackageAssetBaseHrefForViewedCommit({
			ownerUsername: 'kody',
			kodyId: 'doom',
			viewedCommit: 'abc1234',
			assetCommit: 'abc1234',
		}),
	).toBe('/@kody/doom/assets')
	expect(
		getCommunityPackageAssetBaseHrefForViewedCommit({
			ownerUsername: 'kody',
			kodyId: 'doom',
			viewedCommit: 'deadbeef',
			assetCommit: 'abc1234',
		}),
	).toBe(null)
})
