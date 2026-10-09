import { expect, test } from 'vitest'
import { planRepoSessionContentEdits } from './plan-repo-session-content-edits.ts'

test('same-path replace and write instructions compose in order instead of keeping only the last edit', async () => {
	const files = new Map<string, string>([
		[
			'/session/src/ci-secrets.ts',
			[
				'const accountId = status.accountId',
				'const value = status.accountId',
				'const extra = status.accountId',
				'',
			].join('\n'),
		],
		['/session/src/other.ts', 'export const flag = "todo"\n'],
	])
	const reads: Array<string> = []

	const plan = await planRepoSessionContentEdits(
		[
			{
				kind: 'replace',
				path: '/session/src/ci-secrets.ts',
				search: 'const accountId = status.accountId',
				replacement: 'const accountId = accountId',
			},
			{
				kind: 'replace',
				path: '/session/src/ci-secrets.ts',
				search: 'const value = status.accountId',
				replacement: 'const value = accountId',
			},
			{
				kind: 'replace',
				path: '/session/src/other.ts',
				search: '"todo"',
				replacement: '"done"',
			},
			{
				kind: 'replace',
				path: '/session/src/ci-secrets.ts',
				search: 'const extra = status.accountId',
				replacement: 'const extra = accountId',
			},
			{
				kind: 'write',
				path: '/session/src/other.ts',
				content: 'export const flag = "written"\n',
			},
		],
		async (path) => {
			reads.push(path)
			return files.get(path) ?? null
		},
	)

	expect(reads).toEqual(['/session/src/ci-secrets.ts', '/session/src/other.ts'])
	expect(plan.totalChanged).toBe(5)
	expect(plan.edits.map((edit) => edit.changed)).toEqual([
		true,
		true,
		true,
		true,
		true,
	])
	expect(plan.edits[0]?.content).toBe(
		[
			'const accountId = accountId',
			'const value = status.accountId',
			'const extra = status.accountId',
			'',
		].join('\n'),
	)
	expect(plan.edits[1]?.content).toBe(
		[
			'const accountId = accountId',
			'const value = accountId',
			'const extra = status.accountId',
			'',
		].join('\n'),
	)
	expect(plan.edits[3]?.content).toBe(
		[
			'const accountId = accountId',
			'const value = accountId',
			'const extra = accountId',
			'',
		].join('\n'),
	)
	expect(plan.edits[2]?.content).toBe('export const flag = "done"\n')
	expect(plan.edits[4]?.content).toBe('export const flag = "written"\n')
})

test('replace options, missing files, and no-op searches keep the shell contract', async () => {
	const notePath = '/session/src/note.ts'
	const readNote = async (path: string) =>
		path === notePath ? 'Foo foo FOO\n' : null
	const replaceNote = (
		search: string,
		replacement: string,
		options?: Record<string, boolean>,
	) =>
		planRepoSessionContentEdits(
			[{ kind: 'replace', path: notePath, search, replacement, options }],
			readNote,
		)

	const replaceCases: Array<
		[string, string, Record<string, boolean> | undefined, string]
	> = [
		['foo', 'bar', undefined, 'Foo bar FOO\n'],
		['foo', 'bar', { caseSensitive: false }, 'bar bar bar\n'],
		['Foo', 'Ok', { wholeWord: true }, 'Ok foo FOO\n'],
		['FOO', '$PRICE $$ $&', undefined, 'Foo foo $PRICE $$ $&\n'],
		['F[oO]o', 'X', { regex: true }, 'X foo FOO\n'],
	]
	for (const [search, replacement, options, content] of replaceCases) {
		const plan = await replaceNote(search, replacement, options)
		expect([search, options, plan.edits[0]?.content]).toEqual([
			search,
			options,
			content,
		])
	}

	const noOp = await replaceNote('missing', 'nope')
	expect(noOp.totalChanged).toBe(0)
	expect(noOp.edits[0]).toMatchObject({
		changed: false,
		content: 'Foo foo FOO\n',
	})

	const writeJson = await planRepoSessionContentEdits(
		[
			{
				kind: 'writeJson',
				path: '/session/src/config.json',
				value: { enabled: true },
			},
		],
		async () => null,
	)
	expect(writeJson.edits[0]?.content).toBe('{\n  "enabled": true\n}\n')

	await expect(
		planRepoSessionContentEdits(
			[
				{
					kind: 'replace',
					path: '/session/src/missing.ts',
					search: 'x',
					replacement: 'y',
				},
			],
			async () => null,
		),
	).rejects.toThrow('ENOENT: no such file: /session/src/missing.ts')
	await expect(replaceNote('', 'y')).rejects.toThrow(
		'Search query must not be empty',
	)
	await expect(replaceNote('(', 'y', { regex: true })).rejects.toThrow(
		/Invalid search pattern/,
	)
})
