import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { parseJsonc } from './ci/resource-utils.ts'
import {
	elideDeletedMigrationClasses,
	localizeMigrations,
} from './local-dev-migrations.ts'
import {
	writeLocalRuntimeDevConfig,
	writeRuntimeDryRunConfig,
	writeRuntimeRemoteDeployConfig,
	writeRuntimeStartupCheckConfig,
} from './local-runtime-dev-config.ts'

test('localizeMigrations turns transfers into sqlite creates and elides a later delete', () => {
	const localized = localizeMigrations([
		{
			tag: 'v1',
			transferred_classes: [
				{
					from: 'StorageRunner',
					from_script: 'kody',
					to: 'StorageRunner',
				},
				{
					from: 'PackageServiceInstance',
					from_script: 'kody',
					to: 'PackageServiceInstance',
				},
			],
		},
		{
			tag: 'v2',
			deleted_classes: ['PackageServiceInstance'],
		},
	])

	expect(localized).toEqual([
		{
			tag: 'v1',
			new_sqlite_classes: ['StorageRunner'],
		},
	])
	expect(
		sqliteMapAccepts(localized),
		'localized chain must pass wrangler’s local deleted_classes check',
	).toBe(true)
})

test('the committed runtime production chain fails wrangler’s local sqlite map', async () => {
	const source = parseJsonc<{ migrations?: unknown }>(
		await readFile('packages/runtime-worker/wrangler.jsonc', 'utf8'),
	)
	expect(sqliteMapAccepts(source.migrations)).toBe(false)
	expect(sqliteMapAccepts(localizeMigrations(source.migrations))).toBe(true)
	expect(
		sqliteMapAccepts(elideDeletedMigrationClasses(source.migrations)),
	).toBe(true)
})

test('elideDeletedMigrationClasses keeps transfer history and empty last-applied tags', () => {
	const rewritten = elideDeletedMigrationClasses([
		{
			tag: 'v1',
			transferred_classes: [
				{
					from: 'StorageRunner',
					from_script: 'kody',
					to: 'StorageRunner',
				},
				{
					from: 'PackageServiceInstance',
					from_script: 'kody',
					to: 'PackageServiceInstance',
				},
			],
		},
		{
			tag: 'v2',
			deleted_classes: ['PackageServiceInstance'],
		},
	])

	expect(rewritten).toEqual([
		{
			tag: 'v1',
			transferred_classes: [
				{
					from: 'StorageRunner',
					from_script: 'kody',
					to: 'StorageRunner',
				},
			],
		},
		{
			tag: 'v2',
		},
	])
	expect(
		sqliteMapAccepts(rewritten),
		'elided chain must pass wrangler’s local deleted_classes check',
	).toBe(true)
	expect(
		lastAppliedTag(rewritten),
		'Cloudflare last-tag matching still finds v2',
	).toBe('v2')
})

test('writeRuntimeRemoteDeployConfig keeps live transfers and the v2 tag', async () => {
	const tempDir = await mkdtemp(
		path.join(os.tmpdir(), 'kody-runtime-remote-deploy-'),
	)
	const sourcePath = path.join(tempDir, 'wrangler.jsonc')
	try {
		await writeFile(
			sourcePath,
			await readFile('packages/runtime-worker/wrangler.jsonc', 'utf8'),
		)
		const outputPath = await writeRuntimeRemoteDeployConfig({
			runtimeConfigPath: sourcePath,
			envName: 'production',
		})
		expect(path.basename(outputPath)).toBe(
			'wrangler-remote-deploy.generated.json',
		)
		const generated = parseJsonc<{
			migrations?: unknown
			env?: {
				production?: { migrations?: unknown; vars?: Record<string, unknown> }
			}
		}>(await readFile(outputPath, 'utf8'))
		expect(sqliteMapAccepts(generated.migrations)).toBe(true)
		expect(generated.migrations).toEqual(generated.env?.production?.migrations)
		expect(lastAppliedTag(generated.migrations)).toBe('v2')
		expect(JSON.stringify(generated.migrations)).toContain(
			'transferred_classes',
		)
		expect(JSON.stringify(generated.migrations)).toContain('StorageRunner')
		expect(JSON.stringify(generated.migrations)).not.toContain(
			'PackageServiceInstance',
		)
		expect(generated.env?.production?.vars?.WRANGLER_IS_LOCAL_DEV).toBe(
			undefined,
		)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('writeRuntimeDryRunConfig localizes migrations without local-dev vars', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-runtime-dry-run-'))
	const sourcePath = path.join(tempDir, 'wrangler.jsonc')
	try {
		await writeFile(
			sourcePath,
			await readFile('packages/runtime-worker/wrangler.jsonc', 'utf8'),
		)
		const outputPath = await writeRuntimeDryRunConfig({
			runtimeConfigPath: sourcePath,
			envName: 'production',
		})
		const generated = parseJsonc<{
			migrations?: unknown
			env?: {
				production?: { migrations?: unknown; vars?: Record<string, unknown> }
				preview?: { migrations?: unknown }
			}
		}>(await readFile(outputPath, 'utf8'))
		expect(sqliteMapAccepts(generated.migrations)).toBe(true)
		expect(generated.migrations).toEqual(generated.env?.production?.migrations)
		expect(sqliteMapAccepts(generated.env?.preview?.migrations)).toBe(true)
		expect(JSON.stringify(generated)).not.toContain('PackageServiceInstance')
		expect(generated.env?.production?.vars?.WRANGLER_IS_LOCAL_DEV).toBe(
			undefined,
		)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('writeRuntimeStartupCheckConfig writes wrangler.jsonc with an absolute main', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-runtime-startup-'))
	const sourcePath = path.join(tempDir, 'wrangler.jsonc')
	const snapshotDir = path.join(tempDir, 'snapshot')
	try {
		await writeFile(
			sourcePath,
			await readFile('packages/runtime-worker/wrangler.jsonc', 'utf8'),
		)
		await mkdir(snapshotDir, { recursive: true })
		const outputPath = await writeRuntimeStartupCheckConfig({
			runtimeConfigPath: sourcePath,
			envName: 'production',
			outputDir: snapshotDir,
		})
		expect(path.basename(outputPath)).toBe('wrangler.jsonc')
		const generated = parseJsonc<{
			main?: string
			migrations?: unknown
		}>(await readFile(outputPath, 'utf8'))
		expect(path.isAbsolute(generated.main ?? '')).toBe(true)
		expect(sqliteMapAccepts(generated.migrations)).toBe(true)
		expect(JSON.stringify(generated.migrations)).not.toContain(
			'PackageServiceInstance',
		)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('writeLocalRuntimeDevConfig writes a top-level chain wrangler can apply', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-local-runtime-'))
	const sourcePath = path.join(tempDir, 'wrangler.jsonc')
	try {
		const source = await readFile(
			'packages/runtime-worker/wrangler.jsonc',
			'utf8',
		)
		await writeFile(sourcePath, source)
		const outputPath = await writeLocalRuntimeDevConfig({
			runtimeConfigPath: sourcePath,
			envName: 'production',
			mainWorkerDevName: 'kody-production',
			port: '3742',
		})
		const generated = parseJsonc<{
			migrations?: unknown
			env?: { production?: { migrations?: unknown } }
		}>(await readFile(outputPath, 'utf8'))
		expect(sqliteMapAccepts(generated.migrations)).toBe(true)
		expect(generated.migrations).toEqual(generated.env?.production?.migrations)
		expect(JSON.stringify(generated.migrations)).not.toContain(
			'PackageServiceInstance',
		)
		expect(JSON.stringify(generated.migrations)).not.toContain(
			'transferred_classes',
		)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

/**
 * Same order and rules as wrangler’s
 * `getDurableObjectClassNameToUseSQLiteMap` for deleted_classes /
 * new_sqlite_classes. transferred_classes are ignored.
 */
function sqliteMapAccepts(migrations: unknown) {
	if (!Array.isArray(migrations)) return false
	const present = new Set<string>()
	for (const migration of migrations) {
		if (!migration || typeof migration !== 'object') continue
		const record = migration as Record<string, unknown>
		if (Array.isArray(record.deleted_classes)) {
			for (const name of record.deleted_classes) {
				if (typeof name !== 'string' || !present.delete(name)) return false
			}
		}
		if (Array.isArray(record.new_sqlite_classes)) {
			for (const name of record.new_sqlite_classes) {
				if (typeof name !== 'string' || present.has(name)) return false
				present.add(name)
			}
		}
	}
	return true
}

function lastAppliedTag(migrations: unknown) {
	if (!Array.isArray(migrations)) return undefined
	const last = migrations.at(-1)
	if (!last || typeof last !== 'object') return undefined
	const tag = (last as Record<string, unknown>).tag
	return typeof tag === 'string' ? tag : undefined
}
