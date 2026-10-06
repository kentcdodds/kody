import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import ts from 'typescript'
import { loadPrimitivesMap } from '../.agents/skills/visual-recap/scripts/primitives-map.mjs'

const root = process.cwd()

/** Same module the local-execute guide documents for `execute --local`. */
const localExecuteExample =
	'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'

const localExecuteCommand = `npx @kodycodes/cli execute --local --code '${localExecuteExample}'`

test('prefer-local example matches the guide and parses', () => {
	const skill = readFileSync(
		path.join(root, '.agents/skills/prefer-local-cli-execute/SKILL.md'),
		'utf8',
	)
	const guide = readFileSync(
		path.join(root, 'docs/guides/local-execute.md'),
		'utf8',
	)
	expect(skill).toContain(localExecuteCommand)
	expect(guide).toContain(localExecuteCommand)
	expect(skill).not.toContain('--invoke')

	const transpiled = ts.transpileModule(localExecuteExample, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	})
	expect(transpiled.diagnostics ?? []).toEqual([])
	expect(transpiled.outputText).toContain('metaGetCurrentUser')
	expect(transpiled.outputText).toContain('kody:runtime')
})

test('ship-pr tick command stays a local static import', () => {
	const skill = readFileSync(
		path.join(root, '.agents/skills/ship-pr/SKILL.md'),
		'utf8',
	)
	const command = skill.match(/```bash\n([\s\S]*?)```/)?.[1] ?? ''
	expect(command).toContain(
		'import run from "kody:@kentcdodds/ship-pr/tick"; export default (p) => run(p)',
	)
	expect(command).toContain('npx @kodycodes/cli execute --local')
	expect(command).not.toContain('--invoke')
})

test('visual-recap example participants are primitive ids', () => {
	const block = readFileSync(
		path.join(root, '.agents/skills/visual-recap/references/block-format.md'),
		'utf8',
	)
	const ids = [
		...block.matchAll(/participant\s+\w+\s+as\s+([A-Za-z0-9-]+)/g),
	].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
	expect(ids).toEqual(['mcp-server', 'capability-registry'])
	const known = new Set(
		loadPrimitivesMap().primitives.map((primitive) => primitive.id),
	)
	for (const id of ids) {
		expect(known.has(id), id).toBe(true)
	}
})
