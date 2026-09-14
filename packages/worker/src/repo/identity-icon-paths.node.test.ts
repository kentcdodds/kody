import { expect, test } from 'vitest'
import {
	findIdentityIconPath,
	identityIconLeafName,
	identityIconMonogramLetter,
	identityIconSourcePaths,
	isIdentityIconSourcePath,
	isSnapshotRetainedIdentityIconPath,
	shouldStripIdentityIconFromCommunitySnapshot,
	kodyIdentityIconPaths,
	legacyCommunityIconPaths,
	legacyRootIconPaths,
	packageAppIdentityIconPath,
} from './identity-icon-paths.ts'

test('canonical .kody/icon wins over root and community-icon aliases', () => {
	expect(
		findIdentityIconPath({
			'.kody/icon.png': '',
			'icon.svg': '',
			'community-icon.svg': '',
			[packageAppIdentityIconPath]: '',
		}),
	).toBe('.kody/icon.png')
	expect(
		findIdentityIconPath({
			'icon.png': '',
			'community-icon.svg': '',
		}),
	).toBe('icon.png')
	expect(
		findIdentityIconPath({
			'community-icon.jpeg': '',
			'community-icon.svg': '',
		}),
	).toBe('community-icon.svg')
})

test('package-app icon is last and only when requested', () => {
	expect(findIdentityIconPath({ [packageAppIdentityIconPath]: '' })).toBeNull()
	expect(
		findIdentityIconPath(
			{ [packageAppIdentityIconPath]: '' },
			{ includePackageAppIcon: true },
		),
	).toBe(packageAppIdentityIconPath)
	expect(identityIconSourcePaths.at(-1)).toBe(packageAppIdentityIconPath)
	expect(kodyIdentityIconPaths[0]).toBe('.kody/icon.svg')
	expect(legacyRootIconPaths[0]).toBe('icon.svg')
	expect(legacyCommunityIconPaths[0]).toBe('community-icon.svg')
})

test('snapshot retention keeps SVG identity marks and drops rasters', () => {
	expect(isSnapshotRetainedIdentityIconPath('.kody/icon.svg')).toBe(true)
	expect(isSnapshotRetainedIdentityIconPath('icon.svg')).toBe(true)
	expect(isSnapshotRetainedIdentityIconPath('community-icon.svg')).toBe(true)
	expect(isSnapshotRetainedIdentityIconPath('.kody/icon.png')).toBe(false)
	expect(isSnapshotRetainedIdentityIconPath('icons/icon-192.png')).toBe(false)
	expect(isIdentityIconSourcePath('.kody/icon.webp')).toBe(true)
	expect(isIdentityIconSourcePath('public/icon.png')).toBe(false)
	expect(shouldStripIdentityIconFromCommunitySnapshot('.kody/icon.png')).toBe(
		true,
	)
	expect(shouldStripIdentityIconFromCommunitySnapshot('icon.svg')).toBe(false)
	expect(
		shouldStripIdentityIconFromCommunitySnapshot(packageAppIdentityIconPath),
	).toBe(false)
})

test('leaf name and monogram letter come from the package/repo leaf', () => {
	expect(identityIconLeafName('@kentcdodds/github-tools')).toBe('github-tools')
	expect(identityIconLeafName('plain-repo')).toBe('plain-repo')
	expect(identityIconMonogramLetter('@kentcdodds/github-tools')).toBe('G')
	expect(identityIconMonogramLetter('123-notes')).toBe('1')
	expect(identityIconMonogramLetter('')).toBe('R')
})
