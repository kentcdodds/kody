import { expect, test } from 'vitest'
import {
	buildPackageNameForScope,
	rewritePackageFilesForUsernameChange,
	rewriteScopedPackageReferences,
} from './username-scope-rewrite.ts'

test('rewriteScopedPackageReferences rewrites exact scopes only', () => {
	expect(
		rewriteScopedPackageReferences(
			'import x from "kody:@alice/pkg"\nimport y from "kody:@alice-dev/other"',
			{ previousScope: 'alice', nextScope: 'bob' },
		),
	).toBe('import x from "kody:@bob/pkg"\nimport y from "kody:@alice-dev/other"')
})

test('rewritePackageFilesForUsernameChange updates manifest and source references', () => {
	const result = rewritePackageFilesForUsernameChange({
		files: {
			'package.json': `${JSON.stringify(
				{
					name: '@alice/demo',
					exports: { '.': './src/index.ts' },
					kody: {
						id: 'demo',
						description: 'Demo package',
						dependencies: ['@alice/shared', '@other/lib'],
						emits: {
							'@alice/demo.ready': { description: 'Ready' },
						},
						subscriptions: {
							'@alice/shared.event': { handler: './src/on-event.ts' },
							'@other/topic': { handler: './src/on-other.ts' },
						},
					},
				},
				null,
				'\t',
			)}\n`,
			'src/index.ts':
				"import { helper } from 'kody:@alice/shared/helper'\nexport const other = 'kody:@other/lib'\n",
			'README.md': '# @alice/demo\n',
			'binary.bin': 'not-a-scope-reference',
		},
		previousScope: 'alice',
		nextScope: 'bob',
		kodyId: 'demo',
	})

	expect(result.changed).toBe(true)
	expect(result.previousName).toBe('@alice/demo')
	expect(result.nextName).toBe('@bob/demo')
	expect(result.changedPaths).toEqual([
		'package.json',
		'README.md',
		'src/index.ts',
	])

	const manifest = JSON.parse(result.files['package.json']!) as {
		name: string
		kody: {
			dependencies: Array<string>
			emits: Record<string, unknown>
			subscriptions: Record<string, unknown>
		}
	}
	expect(manifest.name).toBe('@bob/demo')
	expect(manifest.kody.dependencies).toEqual(['@bob/shared', '@other/lib'])
	expect(Object.keys(manifest.kody.emits)).toEqual(['@bob/demo.ready'])
	expect(Object.keys(manifest.kody.subscriptions).sort()).toEqual([
		'@bob/shared.event',
		'@other/topic',
	])
	expect(result.files['src/index.ts']).toContain('kody:@bob/shared/helper')
	expect(result.files['src/index.ts']).toContain('kody:@other/lib')
	expect(result.files['README.md']).toBe('# @bob/demo\n')
	expect(result.files['binary.bin']).toBe('not-a-scope-reference')
})

test('rewritePackageFilesForUsernameChange is a no-op when scopes match', () => {
	const files = {
		'package.json': '{"name":"@alice/demo"}\n',
	}
	const result = rewritePackageFilesForUsernameChange({
		files,
		previousScope: 'alice',
		nextScope: 'Alice',
		kodyId: 'demo',
	})
	expect(result.changed).toBe(false)
	expect(result.changedPaths).toEqual([])
	expect(buildPackageNameForScope({ scope: 'Alice', kodyId: 'demo' })).toBe(
		'@alice/demo',
	)
})
