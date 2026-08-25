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
	const files = new Map<string, string>([
		['/session/src/note.ts', 'Foo foo FOO\n'],
	])

	const caseSensitive = await planRepoSessionContentEdits(
		[
			{
				kind: 'replace',
				path: '/session/src/note.ts',
				search: 'foo',
				replacement: 'bar',
			},
		],
		async (path) => files.get(path) ?? null,
	)
	expect(caseSensitive.edits[0]?.content).toBe('Foo bar FOO\n')

	const caseInsensitive = await planRepoSessionContentEdits(
		[
			{
				kind: 'replace',
				path: '/session/src/note.ts',
				search: 'foo',
				replacement: 'bar',
				options: { caseSensitive: false },
			},
		],
		async (path) => files.get(path) ?? null,
	)
	expect(caseInsensitive.edits[0]?.content).toBe('bar bar bar\n')

	const wholeWord = await planRepoSessionContentEdits(
		[
			{
				kind: 'replace',
				path: '/session/src/note.ts',
				search: 'Foo',
				replacement: 'Ok',
				options: { wholeWord: true },
			},
		],
		async (path) => files.get(path) ?? null,
	)
	expect(wholeWord.edits[0]?.content).toBe('Ok foo FOO\n')

	const dollarLiteral = await planRepoSessionContentEdits(
		[
			{
				kind: 'replace',
				path: '/session/src/note.ts',
				search: 'FOO',
				replacement: '$PRICE $$ $&',
			},
		],
		async (path) => files.get(path) ?? null,
	)
	expect(dollarLiteral.edits[0]?.content).toBe('Foo foo $PRICE $$ $&\n')

	const regex = await planRepoSessionContentEdits(
		[
			{
				kind: 'replace',
				path: '/session/src/note.ts',
				search: 'F[oO]o',
				replacement: 'X',
				options: { regex: true },
			},
		],
		async (path) => files.get(path) ?? null,
	)
	expect(regex.edits[0]?.content).toBe('X foo FOO\n')

	const noOp = await planRepoSessionContentEdits(
		[
			{
				kind: 'replace',
				path: '/session/src/note.ts',
				search: 'missing',
				replacement: 'nope',
			},
		],
		async (path) => files.get(path) ?? null,
	)
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

	await expect(
		planRepoSessionContentEdits(
			[
				{
					kind: 'replace',
					path: '/session/src/note.ts',
					search: '',
					replacement: 'y',
				},
			],
			async (path) => files.get(path) ?? null,
		),
	).rejects.toThrow('Search query must not be empty')

	await expect(
		planRepoSessionContentEdits(
			[
				{
					kind: 'replace',
					path: '/session/src/note.ts',
					search: '(',
					replacement: 'y',
					options: { regex: true },
				},
			],
			async (path) => files.get(path) ?? null,
		),
	).rejects.toThrow(/Invalid search pattern/)
})
