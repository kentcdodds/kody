import { expect, test } from 'vitest'
import {
	buildPackageFilesAncestors,
	buildPackageFilesApiHref,
	buildPackageFilesView,
	findDirectoryReadmePath,
	getAccountPackageFilesHref,
	getCommunityPackageFilesHref,
	isReservedPackageFilesKodyId,
	joinPackageFilesPath,
	listPackageFilesChildren,
	normalizePackageFilesPath,
} from './package-files.ts'

const files = {
	'README.md': '# Hello\n\n## Intent\n\nDo a thing.',
	'package.json': '{"name":"@owner/demo"}',
	'src/index.ts': 'export const answer = 42\n',
	'src/lib/util.ts':
		'export function add(a: number, b: number) { return a + b }\n',
	'docs/guide.md': '# Guide\n',
}

test('package files views normalize paths and distinguish root, directories, files, and misses', () => {
	expect(normalizePackageFilesPath(null)).toBe('')
	expect(normalizePackageFilesPath('')).toBe('')
	expect(normalizePackageFilesPath('/')).toBe('')
	expect(normalizePackageFilesPath('src/index.ts')).toBe('src/index.ts')
	expect(normalizePackageFilesPath('/src/lib/util.ts/')).toBe('src/lib/util.ts')
	expect(normalizePackageFilesPath('src/%2E%2E/secrets')).toBe(null)
	expect(normalizePackageFilesPath('../package.json')).toBe(null)
	expect(normalizePackageFilesPath('src\\index.ts')).toBe(null)
	expect(normalizePackageFilesPath('src/%2Findex.ts')).toBe('src/index.ts')

	const root = buildPackageFilesView({ files, selectedPath: '' })
	expect(root).toMatchObject({
		kind: 'directory',
		selectedPath: '',
		contentPath: 'README.md',
		contentKind: 'markdown',
	})
	expect(root?.children.map((child) => child.name)).toEqual([
		'docs',
		'src',
		'package.json',
		'README.md',
	])

	const src = buildPackageFilesView({ files, selectedPath: 'src' })
	expect(src).toMatchObject({
		kind: 'directory',
		contentPath: null,
		content: null,
	})
	expect(src?.children).toEqual([
		{ name: 'lib', path: 'src/lib', kind: 'directory' },
		{ name: 'index.ts', path: 'src/index.ts', kind: 'file' },
	])

	const file = buildPackageFilesView({ files, selectedPath: 'src/index.ts' })
	expect(file).toMatchObject({
		kind: 'file',
		content: 'export const answer = 42\n',
		contentPath: 'src/index.ts',
		contentKind: 'code',
		language: 'ts',
	})

	expect(buildPackageFilesView({ files, selectedPath: 'missing' })).toBeNull()
	expect(buildPackageFilesView({ files: {}, selectedPath: '' })?.kind).toBe(
		'directory',
	)
	expect(
		buildPackageFilesView({ files, selectedPath: 'constructor' }),
	).toBeNull()
	expect(buildPackageFilesView({ files, selectedPath: 'toString' })).toBeNull()
	expect(buildPackageFilesView({ files, selectedPath: '__proto__' })).toBeNull()
	expect(
		buildPackageFilesView({
			files: { constructor: 'export {}\n' },
			selectedPath: 'constructor',
		}),
	).toMatchObject({
		kind: 'file',
		content: 'export {}\n',
	})

	expect(findDirectoryReadmePath(files, '')).toBe('README.md')
	expect(findDirectoryReadmePath(files, 'docs')).toBeNull()
	expect(listPackageFilesChildren(Object.keys(files), 'docs')).toEqual([
		{ name: 'guide.md', path: 'docs/guide.md', kind: 'file' },
	])
	expect(
		buildPackageFilesAncestors('src/lib/util.ts').map((entry) => entry.name),
	).toEqual(['src', 'lib', 'util.ts'])
})

test('files hrefs use /files paths and avoid reserved kody ids', () => {
	expect(isReservedPackageFilesKodyId('packages')).toBe(true)
	expect(isReservedPackageFilesKodyId('devin')).toBe(false)
	expect(
		getCommunityPackageFilesHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: 'devin',
			relativePath: 'src/index.ts',
		}),
	).toBe('/@kentcdodds/devin/files/src/index.ts')
	expect(
		getCommunityPackageFilesHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: 'packages',
			relativePath: 'src/index.ts',
		}),
	).toBe('/community/listing-1/files/src/index.ts')
	expect(getAccountPackageFilesHref({ packageId: 'pkg-1' })).toBe(
		'/account/packages/pkg-1/files',
	)
	expect(joinPackageFilesPath('/@kentcdodds/devin/files', 'src/index.ts')).toBe(
		'/@kentcdodds/devin/files/src/index.ts',
	)
	expect(
		buildPackageFilesApiHref(
			'/profiles/kentcdodds/packages/devin/files.json',
			'src/index.ts',
		),
	).toBe('/profiles/kentcdodds/packages/devin/files.json?path=src%2Findex.ts')
})
