import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..')
const wranglerEnv = { ...process.env, CLOUDFLARE_ENV: 'test' }

async function createLocalD1Fixture() {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'kody-stale-local-'))
	const migrationsDir = path.join(directory, 'migrations')
	const persistTo = path.join(directory, 'state')
	const configPath = path.join(directory, 'wrangler.json')
	await mkdir(migrationsDir)
	await writeFile(
		path.join(migrationsDir, '0001-widgets.sql'),
		'CREATE TABLE widgets (id INTEGER PRIMARY KEY);\n',
	)
	await writeFile(
		path.join(migrationsDir, '0002-widget-color.sql'),
		'ALTER TABLE widgets ADD COLUMN color TEXT;\n',
	)
	const d1Databases = [
		{
			binding: 'APP_DB',
			database_name: 'stale-local-fixture',
			database_id: '00000000-0000-4000-8000-000000000001',
			migrations_dir: './migrations',
		},
	]
	await writeFile(
		configPath,
		JSON.stringify({
			name: 'stale-local-fixture',
			d1_databases: d1Databases,
			env: { test: { d1_databases: d1Databases } },
		}),
	)
	return {
		migrationsDir,
		persistTo,
		configPath,
		[Symbol.asyncDispose]: () =>
			rm(directory, { recursive: true, force: true }),
	}
}

function applyMigrations(fixture: { configPath: string; persistTo: string }) {
	return spawnSync(
		path.join(repoRoot, 'node_modules', '.bin', 'wrangler'),
		[
			'd1',
			'migrations',
			'apply',
			'APP_DB',
			'--local',
			'--env',
			'test',
			'--config',
			fixture.configPath,
			'--persist-to',
			fixture.persistTo,
		],
		{ cwd: repoRoot, encoding: 'utf8', env: wranglerEnv },
	)
}

function runStaleCheck(fixture: {
	configPath: string
	persistTo: string
	migrationsDir: string
}) {
	return spawnSync(
		process.execPath,
		[
			'tools/check-stale-local-migrations.ts',
			'--binding',
			'APP_DB',
			'--migrations-dir',
			fixture.migrationsDir,
			'--config',
			fixture.configPath,
			'--persist-to',
			fixture.persistTo,
		],
		{ cwd: repoRoot, encoding: 'utf8', env: wranglerEnv },
	)
}

test('a renamed migration fails the local check with the stale name and reset step before apply re-runs it', async () => {
	await using fixture = await createLocalD1Fixture()

	const fresh = runStaleCheck(fixture)
	expect(fresh).toMatchObject({ status: 0 })

	const applied = applyMigrations(fixture)
	expect(applied).toMatchObject({ status: 0 })
	const matching = runStaleCheck(fixture)
	expect(matching).toMatchObject({ status: 0 })

	await rename(
		path.join(fixture.migrationsDir, '0002-widget-color.sql'),
		path.join(fixture.migrationsDir, '0003-widget-color.sql'),
	)
	const stale = runStaleCheck(fixture)
	expect(stale.status).toBe(1)
	expect(stale.stderr).toContain(
		`Local APP_DB state in ${fixture.persistTo} records migrations that no longer exist in ${fixture.migrationsDir}:\n  0002-widget-color.sql\n`,
	)
	expect(stale.stderr).toContain(`  rm -rf ${fixture.persistTo}`)

	const reapplied = applyMigrations(fixture)
	expect(reapplied.status).not.toBe(0)
	expect(`${reapplied.stdout}\n${reapplied.stderr}`).toContain(
		'duplicate column name',
	)

	await rm(fixture.persistTo, { recursive: true, force: true })
	const reset = runStaleCheck(fixture)
	expect(reset).toMatchObject({ status: 0 })
}, 120_000)
