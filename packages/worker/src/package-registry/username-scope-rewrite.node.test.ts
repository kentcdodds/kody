import { expect, test } from 'vitest'
import {
	buildPackageNameForScope,
	rewritePackageFilesForUsernameChange,
	rewriteScopedPackageReferences,
} from './username-scope-rewrite.ts'

test('username scope rewrite updates references, package files, and no-ops when unchanged', () => {
	expect(
		rewriteScopedPackageReferences(
			'import x from "kody:@alice/pkg"\nimport y from "kody:@alice-dev/other"',
			{ previousScope: 'alice', nextScope: 'bob' },
		),
	).toBe('import x from "kody:@bob/pkg"\nimport y from "kody:@alice-dev/other"')

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
	expect(result.files['binary.bin']).toBe('not-a-scope-reference')

	const unchangedFiles = {
		'package.json': '{"name":"@alice/demo"}\n',
	}
	const noOp = rewritePackageFilesForUsernameChange({
		files: unchangedFiles,
		previousScope: 'alice',
		nextScope: 'Alice',
		kodyId: 'demo',
	})
	expect(noOp.changed).toBe(false)
	expect(noOp.changedPaths).toEqual([])
	expect(buildPackageNameForScope({ scope: 'Alice', kodyId: 'demo' })).toBe(
		'@alice/demo',
	)
})
