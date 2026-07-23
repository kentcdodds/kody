import { expect, test, vi } from 'vitest'

import {
	type DrillAdapters,
	buildDrillCommands,
	buildVerificationQueries,
	runD1RestoreDrill,
} from './d1-restore-drill.ts'
import { buildD1RestoreWranglerConfig } from './d1-restore-drill-cli.ts'
import {
	createAdapters,
	createBaseline,
	createTrustRegistry,
	drillInput,
	now,
	productionAccountId,
	productionUuid,
	queryRows,
	targetAccountId,
	targetUuid,
} from './disaster-recovery-test-support.ts'

test('dry-run is non-mutating and live execution creates in a distinct approved account immediately before import', async () => {
	const dryAdapters = createAdapters()
	const dryRun = await runD1RestoreDrill(drillInput(), dryAdapters)
	expect(dryRun.dryRun).toBe(true)
	expect(dryRun.commands[0]).toMatchObject({
		kind: 'provision',
		program: 'cloudflare-api',
	})
	expect(dryRun.commands[1]?.args).toEqual([
		'd1',
		'execute',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		'<temporary-wrangler-config>',
		'--file',
		'/operator/downloads/backup.sql',
	])
	expect(dryAdapters.createTarget).not.toHaveBeenCalled()
	expect(dryAdapters.writeTemporaryConfig).not.toHaveBeenCalled()
	expect(dryAdapters.run).not.toHaveBeenCalled()

	const events: Array<string> = []
	const liveAdapters: DrillAdapters = {
		async createTarget(input) {
			events.push(`create:${input.accountId}:${input.name}`)
			return {
				uuid: targetUuid,
				name: input.name,
				createdAt: now.toISOString(),
			}
		},
		now() {
			return now
		},
		async writeTemporaryConfig(input) {
			events.push(`config:${input.targetName}:${input.targetUuid}`)
			return {
				path: '/tmp/live-restore/wrangler.json',
				async cleanup() {
					events.push('cleanup-config')
				},
			}
		},
		async run(command) {
			events.push(command.kind)
			expect(command.args).toContain('D1_RESTORE_TARGET')
			expect(command.args).toContain('/tmp/live-restore/wrangler.json')
		},
		async query(command, query) {
			expect(command.args).toContain('D1_RESTORE_TARGET')
			expect(command.args).toContain('/tmp/live-restore/wrangler.json')
			events.push(`${query.phase}:${query.id}`)
			return queryRows(query)
		},
	}
	await runD1RestoreDrill(drillInput({ dryRun: false }), liveAdapters)
	expect(events).toEqual([
		`create:${targetAccountId}:kody-drill`,
		`config:kody-drill:${targetUuid}`,
		'import',
		'baseline:integrity',
		'baseline:foreign-keys',
		'baseline:migrations',
		'baseline:schema',
		'baseline:sequences',
		'baseline:isolation',
		'cleanup-config',
	])
})

test('target account, returned creation evidence, and forward baseline fail closed', async () => {
	await expect(
		runD1RestoreDrill(
			drillInput({ targetAccountId: productionAccountId }),
			createAdapters(),
		),
	).rejects.toThrow('target account must differ')
	await expect(
		runD1RestoreDrill(
			drillInput({
				trustRegistry: createTrustRegistry({ drillTargets: [] }),
				dryRun: false,
			}),
			createAdapters(),
		),
	).rejects.toThrow('target account/name is not approved')
	const staleAdapters = createAdapters()
	staleAdapters.createTarget = vi.fn(async () => ({
		uuid: targetUuid,
		name: 'kody-drill',
		createdAt: '2026-07-20T00:00:00.000Z',
	}))
	await expect(
		runD1RestoreDrill(drillInput({ dryRun: false }), staleAdapters),
	).rejects.toThrow('outside creation window')
	expect(staleAdapters.run).not.toHaveBeenCalled()
	const productionIdAdapters = createAdapters()
	productionIdAdapters.createTarget = vi.fn(async () => ({
		uuid: productionUuid,
		name: 'kody-drill',
		createdAt: now.toISOString(),
	}))
	await expect(
		runD1RestoreDrill(drillInput({ dryRun: false }), productionIdAdapters),
	).rejects.toThrow('production database UUID')
	expect(productionIdAdapters.run).not.toHaveBeenCalled()

	await expect(
		runD1RestoreDrill(
			drillInput({ applyForwardMigrations: true }),
			createAdapters(),
		),
	).rejects.toThrow('require a post-forward baseline')
	const baseline = createBaseline()
	const commands = buildDrillCommands({
		backupFile: '/operator/downloads/backup.sql',
		targetAccountId,
		targetName: 'kody-drill',
		configPath: '/tmp/restore/wrangler.json',
		baseline,
		applyForwardMigrations: true,
		postForwardBaseline: baseline,
	})
	expect(
		commands.map((command) =>
			command.kind === 'verification'
				? `${command.phase}-verification`
				: command.kind,
		),
	).toEqual([
		'provision',
		'import',
		...Array<string>(6).fill('baseline-verification'),
		'migration',
		...Array<string>(6).fill('post-forward-verification'),
	])
	expect(buildVerificationQueries(baseline, 'baseline')).toHaveLength(6)
})

test('temporary D1 config and live forward migration commands target the configured binding exactly', async () => {
	const configPath = '/tmp/kody-d1-restore-abc/wrangler.json'
	expect(
		buildD1RestoreWranglerConfig({
			configPath,
			migrationsDirectory: '/workspace/packages/worker/migrations',
			targetName: 'kody-drill',
			targetUuid,
		}),
	).toEqual({
		d1_databases: [
			{
				binding: 'D1_RESTORE_TARGET',
				database_name: 'kody-drill',
				database_id: targetUuid,
				migrations_dir: '../../workspace/packages/worker/migrations',
			},
		],
	})

	const executedCommands: Array<{
		kind: string
		phase?: string
		args: Array<string>
	}> = []
	const adapters: DrillAdapters = {
		async createTarget(input) {
			return {
				uuid: targetUuid,
				name: input.name,
				createdAt: now.toISOString(),
			}
		},
		now() {
			return now
		},
		async writeTemporaryConfig(input) {
			expect(input).toEqual({ targetName: 'kody-drill', targetUuid })
			return { path: configPath, cleanup: vi.fn(async () => undefined) }
		},
		async run(command) {
			executedCommands.push(command)
		},
		async query(command, query) {
			executedCommands.push(command)
			return queryRows(query)
		},
	}
	const baseline = createBaseline()
	await runD1RestoreDrill(
		drillInput({
			dryRun: false,
			applyForwardMigrations: true,
			postForwardBaselineId: 'post-forward-baseline-2026',
		}),
		adapters,
	)
	const expectedPlan = buildDrillCommands({
		backupFile: '/operator/downloads/backup.sql',
		targetAccountId,
		targetName: 'kody-drill',
		configPath,
		baseline,
		applyForwardMigrations: true,
		postForwardBaseline: baseline,
	})
	expect(executedCommands).toEqual(expectedPlan.slice(1))
	expect(executedCommands[0]?.args).toEqual([
		'd1',
		'execute',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		configPath,
		'--file',
		'/operator/downloads/backup.sql',
	])
	expect(executedCommands[1]?.args).toEqual([
		'd1',
		'execute',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		configPath,
		'--json',
		'--command',
		'PRAGMA quick_check',
	])
	expect(executedCommands[2]?.args.at(-1)).toBe('PRAGMA foreign_key_check')
	expect(executedCommands[7]?.args).toEqual([
		'd1',
		'migrations',
		'apply',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		configPath,
	])
	for (const command of executedCommands) {
		expect(command.args).not.toContain(targetUuid)
		expect(command.args).toContain(configPath)
	}
})
