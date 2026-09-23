import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { buildLocalMigrationCommands } from './apply-local-app-migrations.ts'
import { resolveLocalD1PersistPath } from './local-d1-persist.ts'
import { buildSeedWranglerArgs, parseArgs } from './seed-test-data.ts'

function persistPathFromArgs(args: ReadonlyArray<string>) {
	const flagIndex = args.indexOf('--persist-to')
	const equalsForm = args.find((argument) =>
		argument.startsWith('--persist-to='),
	)
	if (equalsForm) return equalsForm.slice('--persist-to='.length)
	return flagIndex === -1 ? undefined : args[flagIndex + 1]
}

test('local migrate and seed target the persist directory Vite opens', () => {
	const viteConfig = readFileSync(
		new URL('../vite.config.ts', import.meta.url),
		'utf8',
	)
	expect(viteConfig).toContain('resolveLocalD1PersistPath()')
	expect(viteConfig).toContain('persistState: { path: persistPath }')

	const sharedPath = resolveLocalD1PersistPath({ env: {} })
	expect(sharedPath).toBe('.wrangler/state')

	const commands = buildLocalMigrationCommands({ argv: [], env: {} })
	expect(commands).toHaveLength(4)
	for (const command of commands) {
		expect(persistPathFromArgs(command)).toBe(sharedPath)
	}
	expect(commands[1]).toContain('APP_DB')
	expect(commands[2]).toContain('AUDIT_DB')
	expect(commands[3]).toEqual(
		expect.arrayContaining([
			'JOBS_DB',
			'--config',
			'packages/jobs-worker/wrangler.jsonc',
			'--env-file=packages/worker/.env',
		]),
	)
	expect(commands[0]?.[0]).toBe('tools/ci/reset-migration-bookkeeping.ts')
	expect(commands[0]).not.toContain('--env-file=packages/worker/.env')

	const seedArgs = buildSeedWranglerArgs('select 1', parseArgs(['--local']), {})
	expect(persistPathFromArgs(seedArgs)).toBe(sharedPath)
	expect(seedArgs).toContain('--local')
	expect(seedArgs).not.toContain('--remote')
})

test('explicit persist-to wins over WRANGLER_PERSIST_TO, and remote seed skips it', () => {
	const env = { WRANGLER_PERSIST_TO: '.wrangler/state/from-env' }
	const fromEnv = buildLocalMigrationCommands({ argv: [], env })
	for (const command of fromEnv) {
		expect(persistPathFromArgs(command)).toBe('.wrangler/state/from-env')
	}

	const explicit = buildLocalMigrationCommands({
		argv: ['--persist-to', '.wrangler/state/e2e'],
		env,
	})
	for (const command of explicit) {
		expect(persistPathFromArgs(command)).toBe('.wrangler/state/e2e')
	}

	const equalsForm = buildLocalMigrationCommands({
		argv: ['--persist-to=.wrangler/state/custom'],
		env: {},
	})
	expect(persistPathFromArgs(equalsForm[1] ?? [])).toBe(
		'.wrangler/state/custom',
	)

	expect(() =>
		buildLocalMigrationCommands({ argv: ['--remote'], env: {} }),
	).toThrow(/Only --persist-to is allowed/)

	const remoteSeed = buildSeedWranglerArgs(
		'select 1',
		parseArgs(['--remote', '--config', 'packages/worker/wrangler.jsonc']),
		env,
	)
	expect(remoteSeed).toContain('--remote')
	expect(persistPathFromArgs(remoteSeed)).toBeUndefined()

	const explicitSeed = buildSeedWranglerArgs(
		'select 1',
		parseArgs(['--local', '--persist-to', '.wrangler/state/e2e']),
		env,
	)
	expect(persistPathFromArgs(explicitSeed)).toBe('.wrangler/state/e2e')
})
