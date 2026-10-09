import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashMigrationContent } from '../check-migrations.ts'
import {
	assertPreviewOnlyD1Target,
	isAllowedPreviewD1DatabaseName,
	parseArgs,
	planRenamedMigrationRewrites,
	readD1DatabaseNameFromConfig,
	resolveHistoricalMigrationContent,
} from './rewrite-renamed-preview-migrations.ts'

function digest(filename: string, sql: string) {
	return { filename, sha256: hashMigrationContent(sql) }
}

test('planRenamedMigrationRewrites renames when historical sha matches one current file', () => {
	const sql = 'ALTER TABLE oauth_apps ADD COLUMN visibility TEXT;\n'
	const plan = planRenamedMigrationRewrites({
		appliedNames: [
			'0001-squashed-init.sql',
			'0074-platform-oauth-app-visibility.sql',
		],
		currentFiles: [
			digest('0001-squashed-init.sql', '-- baseline\n'),
			digest('0075-platform-oauth-app-visibility.sql', sql),
		],
		resolveHistoricalContent: (filename) =>
			filename === '0074-platform-oauth-app-visibility.sql' ? sql : null,
	})

	expect(plan.skipped).toEqual([])
	expect(plan.rewrites).toEqual([
		{
			kind: 'rename',
			from: '0074-platform-oauth-app-visibility.sql',
			to: '0075-platform-oauth-app-visibility.sql',
			sha256: hashMigrationContent(sql),
		},
	])
})

test('planRenamedMigrationRewrites drops stale name when target is already applied', () => {
	const sql = 'ALTER TABLE oauth_apps ADD COLUMN visibility TEXT;\n'
	const plan = planRenamedMigrationRewrites({
		appliedNames: [
			'0074-platform-oauth-app-visibility.sql',
			'0075-platform-oauth-app-visibility.sql',
		],
		currentFiles: [digest('0075-platform-oauth-app-visibility.sql', sql)],
		resolveHistoricalContent: (filename) =>
			filename === '0074-platform-oauth-app-visibility.sql' ? sql : null,
	})

	expect(plan.rewrites).toEqual([
		{
			kind: 'drop-stale',
			from: '0074-platform-oauth-app-visibility.sql',
			to: '0075-platform-oauth-app-visibility.sql',
			sha256: hashMigrationContent(sql),
		},
	])
})

test('planRenamedMigrationRewrites skips when git history is gone (no content-blind slug match)', () => {
	const sql = 'ALTER TABLE oauth_apps ADD COLUMN visibility TEXT;\n'
	const plan = planRenamedMigrationRewrites({
		appliedNames: ['0074-platform-oauth-app-visibility.sql'],
		currentFiles: [digest('0075-platform-oauth-app-visibility.sql', sql)],
		resolveHistoricalContent: () => null,
	})

	expect(plan.rewrites).toEqual([])
	expect(plan.skipped).toEqual([
		{
			name: '0074-platform-oauth-app-visibility.sql',
			reason:
				'could not recover historical SQL content from git; use reset-d1 when content cannot be sha-matched',
		},
	])
})

test('planRenamedMigrationRewrites skips matching slug when replacement adds SQL and history is gone', () => {
	// Same kebab slug, additional statements — without recoverable content we
	// must not rewrite, or preview would treat the new SQL as already applied.
	const plan = planRenamedMigrationRewrites({
		appliedNames: ['0074-platform-oauth-app-visibility.sql'],
		currentFiles: [
			digest(
				'0075-platform-oauth-app-visibility.sql',
				'ALTER TABLE oauth_apps ADD COLUMN visibility TEXT;\nALTER TABLE oauth_apps ADD COLUMN visibility_set_at INTEGER;\n',
			),
		],
		resolveHistoricalContent: () => null,
	})

	expect(plan.rewrites).toEqual([])
	expect(plan.skipped).toHaveLength(1)
	expect(plan.skipped[0]?.name).toBe('0074-platform-oauth-app-visibility.sql')
	expect(plan.skipped[0]?.reason).toMatch(/use reset-d1/)
})

test('planRenamedMigrationRewrites skips when content changed or history cannot match', () => {
	const plan = planRenamedMigrationRewrites({
		appliedNames: ['0074-platform-oauth-app-visibility.sql'],
		currentFiles: [
			digest(
				'0075-platform-oauth-app-visibility.sql',
				'ALTER TABLE oauth_apps ADD COLUMN visibility TEXT NOT NULL DEFAULT "public";\n',
			),
		],
		resolveHistoricalContent: (filename) =>
			filename === '0074-platform-oauth-app-visibility.sql'
				? 'ALTER TABLE oauth_apps ADD COLUMN visibility TEXT;\n'
				: null,
	})

	expect(plan.rewrites).toEqual([])
	expect(plan.skipped).toHaveLength(1)
	expect(plan.skipped[0]?.name).toBe('0074-platform-oauth-app-visibility.sql')
	expect(plan.skipped[0]?.reason).toMatch(/no current migration matches sha256/)

	const missingHistory = planRenamedMigrationRewrites({
		appliedNames: ['0074-gone.sql'],
		currentFiles: [digest('0075-other.sql', 'SELECT 1;\n')],
		resolveHistoricalContent: () => null,
	})
	expect(missingHistory.rewrites).toEqual([])
	expect(missingHistory.skipped[0]?.reason).toMatch(/use reset-d1/)
})

test('planRenamedMigrationRewrites skips ambiguous sha matches', () => {
	const sql = 'SELECT 1;\n'
	const plan = planRenamedMigrationRewrites({
		appliedNames: ['0074-old.sql'],
		currentFiles: [digest('0075-a.sql', sql), digest('0076-b.sql', sql)],
		resolveHistoricalContent: () => sql,
	})

	expect(plan.rewrites).toEqual([])
	expect(plan.skipped[0]?.reason).toMatch(/ambiguous sha256/)
})

test('parseArgs requires remote, binding, config, and migrations-dir', () => {
	expect(() => parseArgs([])).toThrow(/--remote/)
	expect(() => parseArgs(['--remote'])).toThrow(/--binding/)
	expect(
		parseArgs([
			'--remote',
			'--binding',
			'APP_DB',
			'--config',
			'w.json',
			'--migrations-dir',
			'packages/worker/migrations',
			'--dry-run',
		]),
	).toEqual({
		binding: 'APP_DB',
		config: 'w.json',
		migrationsDir: 'packages/worker/migrations',
		dryRun: true,
	})
})

test('resolveHistoricalMigrationContent recovers SQL from rename via commit parent', () => {
	const dir = mkdtempSync(join(tmpdir(), 'rewrite-git-rename-'))
	const migrationsDir = join(dir, 'packages', 'worker', 'migrations')
	mkdirSync(migrationsDir, { recursive: true })
	const run = (args: Array<string>) => {
		const result = spawnSync('git', args, {
			cwd: dir,
			encoding: 'utf8',
		})
		expect(result.status, result.stderr).toBe(0)
		return result.stdout
	}
	try {
		run(['init'])
		run(['config', 'user.email', 'test@example.com'])
		run(['config', 'user.name', 'test'])
		const sql = 'ALTER TABLE oauth_apps ADD COLUMN visibility TEXT;\n'
		const oldName = '0074-platform-oauth-app-visibility.sql'
		const newName = '0075-platform-oauth-app-visibility.sql'
		writeFileSync(join(migrationsDir, oldName), sql)
		run(['add', '.'])
		run(['commit', '-m', 'add migration'])
		run([
			'mv',
			`packages/worker/migrations/${oldName}`,
			`packages/worker/migrations/${newName}`,
		])
		run(['commit', '-m', 'renumber migration'])

		expect(
			resolveHistoricalMigrationContent({
				migrationsDir: 'packages/worker/migrations',
				filename: oldName,
				cwd: dir,
			}),
		).toBe(sql)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('isAllowedPreviewD1DatabaseName accepts per-preview names only', () => {
	expect(isAllowedPreviewD1DatabaseName('kody-pr-12-db')).toBe(true)
	expect(isAllowedPreviewD1DatabaseName('kody-pr-12-audit-db')).toBe(true)
	expect(isAllowedPreviewD1DatabaseName('kody-pr-12-jobs-db')).toBe(true)
	expect(isAllowedPreviewD1DatabaseName('kody-preview-jobs')).toBe(false)
	expect(isAllowedPreviewD1DatabaseName('kody')).toBe(false)
	expect(isAllowedPreviewD1DatabaseName('kody-audit')).toBe(false)
	expect(isAllowedPreviewD1DatabaseName('kody-jobs')).toBe(false)
})

test('readD1DatabaseNameFromConfig and assertPreviewOnlyD1Target gate production names', () => {
	const dir = mkdtempSync(join(tmpdir(), 'rewrite-preview-d1-'))
	try {
		const previewConfig = join(dir, 'preview.json')
		writeFileSync(
			previewConfig,
			JSON.stringify({
				env: {
					preview: {
						d1_databases: [
							{
								binding: 'APP_DB',
								database_name: 'kody-pr-9-db',
								database_id: 'uuid',
							},
						],
					},
				},
			}),
		)
		expect(
			readD1DatabaseNameFromConfig({
				configPath: previewConfig,
				binding: 'APP_DB',
				envName: 'preview',
			}),
		).toBe('kody-pr-9-db')
		expect(
			assertPreviewOnlyD1Target({
				config: previewConfig,
				binding: 'APP_DB',
			}),
		).toBe('kody-pr-9-db')

		const prodConfig = join(dir, 'prod.json')
		writeFileSync(
			prodConfig,
			JSON.stringify({
				env: {
					preview: {
						d1_databases: [
							{
								binding: 'APP_DB',
								database_name: 'kody',
								database_id: 'uuid',
							},
						],
					},
				},
			}),
		)
		expect(() =>
			assertPreviewOnlyD1Target({ config: prodConfig, binding: 'APP_DB' }),
		).toThrow(/not a preview D1 name/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
