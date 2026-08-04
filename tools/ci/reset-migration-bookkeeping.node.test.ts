import { expect, test } from 'vitest'
import {
	classifyMigrationBookkeeping,
	parseArgs,
	preSquashMigrationNames,
	squashedInitMigrationName,
} from './reset-migration-bookkeeping.ts'

test('frozen pre-squash list matches the applied production history shape', () => {
	expect(preSquashMigrationNames).toHaveLength(145)
	expect(preSquashMigrationNames[0]).toBe('0001-init.sql')
	expect(preSquashMigrationNames.at(-1)).toBe(
		'0144-drop-jobs-observability-columns.sql',
	)
	expect(preSquashMigrationNames).not.toContain(squashedInitMigrationName)
	expect(new Set(preSquashMigrationNames).size).toBe(
		preSquashMigrationNames.length,
	)
})

test('empty bookkeeping classifies as fresh', () => {
	expect(classifyMigrationBookkeeping([])).toEqual({ state: 'fresh' })
})

test('exactly the squashed baseline row classifies as squashed', () => {
	expect(classifyMigrationBookkeeping([squashedInitMigrationName])).toEqual({
		state: 'squashed',
	})
})

test('exactly the frozen pre-squash set classifies as pre-squash', () => {
	const shuffled = [...preSquashMigrationNames].reverse()
	expect(classifyMigrationBookkeeping(shuffled)).toEqual({
		state: 'pre-squash',
	})
})

test('a missing pre-squash migration is refused with a set diff', () => {
	const applied = preSquashMigrationNames.filter(
		(name) => name !== '0090-webhook-endpoints.sql',
	)
	expect(classifyMigrationBookkeeping(applied)).toEqual({
		state: 'unexpected',
		missing: ['0090-webhook-endpoints.sql'],
		extra: [],
	})
})

test('an extra unknown migration is refused with a set diff', () => {
	const applied = [...preSquashMigrationNames, '0145-rogue.sql']
	expect(classifyMigrationBookkeeping(applied)).toEqual({
		state: 'unexpected',
		missing: [],
		extra: ['0145-rogue.sql'],
	})
})

test('squashed row mixed with history is refused', () => {
	const applied = [squashedInitMigrationName, ...preSquashMigrationNames]
	const result = classifyMigrationBookkeeping(applied)
	expect(result.state).toBe('unexpected')
})

test('parseArgs requires an explicit mode', () => {
	expect(() => parseArgs([])).toThrow(/--remote.*--local/)
})

test('parseArgs parses mode, config, binding, and both persist-to forms', () => {
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
})

test('parseArgs rejects unknown arguments', () => {
	expect(() => parseArgs(['--local', '--frobnicate'])).toThrow(
		/Unsupported argument/,
	)
})
