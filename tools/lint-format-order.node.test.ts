import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..')

type PackageJson = {
	scripts: Record<string, string>
	'lint-staged': Record<string, Array<string>>
}

const packageJson = JSON.parse(
	readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as PackageJson

const duplicateImportFixture = [
	"import { basename } from 'node:path'",
	"import { dirname } from 'node:path'",
	'',
	'export const parts = [basename, dirname]',
	'',
].join('\n')

function run(command: string, args: ReadonlyArray<string>) {
	const result = spawnSync(
		path.join(repoRoot, 'node_modules', '.bin', command),
		args,
		{ cwd: repoRoot, encoding: 'utf8' },
	)
	if (result.error) throw result.error
	return result
}

function lintStagedScriptCommands() {
	const commands =
		packageJson['lint-staged']['*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}']
	if (!commands) throw new Error('lint-staged has no TypeScript glob')
	return commands.map((command) => command.split(' '))
}

/** `npm run a && npm run b` resolved to each script's argv. */
function validateFixScriptCommands() {
	return packageJson.scripts['validate:fix']!.split('&&').map((step) => {
		const match = /^npm run (\S+)$/.exec(step.trim())
		if (!match?.[1]) throw new Error(`Unexpected validate:fix step: ${step}`)
		const script = packageJson.scripts[match[1]]
		if (!script) throw new Error(`Missing script ${match[1]}`)
		return script.split(' ')
	})
}

async function runPipelineOnFixture(
	commands: ReadonlyArray<ReadonlyArray<string>>,
	targetCommand: (argv: ReadonlyArray<string>, file: string) => Array<string>,
) {
	await mkdir(path.join(repoRoot, '.tmp'), { recursive: true })
	const dir = await mkdtemp(path.join(repoRoot, '.tmp', 'lint-format-order-'))
	try {
		const file = path.join(dir, 'fixture.ts')
		await writeFile(file, duplicateImportFixture)
		for (const argv of commands) {
			const [command, ...args] = targetCommand(argv, file)
			const result = run(command!, args)
			expect({ argv, status: result.status, stderr: result.stderr }).toEqual(
				expect.objectContaining({ status: 0 }),
			)
		}
		const check = run('oxfmt', ['--check', file])
		return {
			contents: await readFile(file, 'utf8'),
			formatted: check.status === 0,
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

const mergedImport = "import { basename, dirname } from 'node:path'"

test('lint-staged applies lint autofixes before formatting staged files', async () => {
	const result = await runPipelineOnFixture(
		lintStagedScriptCommands(),
		(argv, file) => [...argv, file],
	)
	expect(result.contents).toContain(mergedImport)
	expect(result.formatted).toBe(true)
})

test('validate:fix applies lint autofixes before formatting the tree', async () => {
	const result = await runPipelineOnFixture(
		validateFixScriptCommands(),
		(argv, file) => {
			const [command, ...args] = argv
			const withoutRepoPath = args.filter((arg) => arg !== '.')
			return [command!, ...withoutRepoPath, file]
		},
	)
	expect(result.contents).toContain(mergedImport)
	expect(result.formatted).toBe(true)
})
