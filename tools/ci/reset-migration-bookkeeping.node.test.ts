import { expect, test } from 'vitest'
import {
	classifyMigrationBookkeeping,
	parseArgs,
	preSquashGhostMigrationNames,
	preSquashMigrationNames,
	squashedInitMigrationName,
} from './reset-migration-bookkeeping.ts'

test('migration bookkeeping classifies fresh, squashed, pre-squash, and unexpected sets', () => {
	expect(preSquashMigrationNames).toHaveLength(145)
	expect(preSquashMigrationNames[0]).toBe('0001-init.sql')
	expect(preSquashMigrationNames.at(-1)).toBe(
		'0144-drop-jobs-observability-columns.sql',
	)
	expect(preSquashMigrationNames).not.toContain(squashedInitMigrationName)
	expect(new Set(preSquashMigrationNames).size).toBe(
		preSquashMigrationNames.length,
	)

	expect(classifyMigrationBookkeeping([])).toEqual({ state: 'fresh' })
	expect(classifyMigrationBookkeeping([squashedInitMigrationName])).toEqual({
		state: 'squashed',
	})
	expect(
		classifyMigrationBookkeeping([...preSquashMigrationNames].reverse()),
	).toEqual({ state: 'pre-squash' })
	expect(
		classifyMigrationBookkeeping([
			...preSquashMigrationNames,
			...preSquashGhostMigrationNames,
		]),
	).toEqual({ state: 'pre-squash' })
	expect(
		classifyMigrationBookkeeping([
			...preSquashMigrationNames,
			'0006-drop-mock-request-tables.sql',
		]),
	).toEqual({ state: 'pre-squash' })

	const withoutFinal = preSquashMigrationNames.slice(0, -1)
	expect(
		classifyMigrationBookkeeping([
			...withoutFinal,
			...preSquashGhostMigrationNames,
		]).state,
	).toBe('unexpected')
	expect(
		classifyMigrationBookkeeping(
			preSquashMigrationNames.filter(
				(name) => name !== '0090-webhook-endpoints.sql',
			),
		),
	).toEqual({
		state: 'unexpected',
		missing: ['0090-webhook-endpoints.sql'],
		extra: [],
	})
	expect(
		classifyMigrationBookkeeping([
			...preSquashMigrationNames,
			'0145-rogue.sql',
		]),
	).toEqual({
		state: 'unexpected',
		missing: [],
		extra: ['0145-rogue.sql'],
	})
	expect(
		classifyMigrationBookkeeping([
			squashedInitMigrationName,
			...preSquashMigrationNames,
		]).state,
	).toBe('unexpected')
})

test('parseArgs requires an explicit mode and accepts config, binding, and persist-to forms', () => {
	expect(() => parseArgs([])).toThrow(/--remote.*--local/)
	expect(parseArgs(['--remote', '--config', 'w.json'])).toEqual({
		mode: '--remote',
		config: 'w.json',
		binding: 'APP_DB',
	})
	expect(parseArgs(['--local', '--persist-to', '.wrangler/state/x'])).toEqual({
		mode: '--local',
		persistTo: '.wrangler/state/x',
		binding: 'APP_DB',
	})
	expect(parseArgs(['--local', '--persist-to=.wrangler/state/y'])).toEqual({
		mode: '--local',
		persistTo: '.wrangler/state/y',
		binding: 'APP_DB',
	})
	expect(() => parseArgs(['--local', '--frobnicate'])).toThrow(
		/Unsupported argument/,
	)
})
