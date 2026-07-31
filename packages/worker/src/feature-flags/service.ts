import { fnv1a32 } from '@kody-internal/shared/fnv1a.ts'
import {
	featureFlagDefinitions,
	featureFlagKeys,
	getFeatureFlagDefinition,
	isFeatureFlagKey,
	type FeatureFlagKey,
} from './registry.ts'
import { type AdminFeatureFlag } from './types.ts'

export type { AdminFeatureFlag } from './types.ts'

const maxFeatureFlagNoteLength = 500

type GlobalFlagRow = {
	key: string
	enabled: number
	rollout_percent: number | null
	note: string
	updated_by_stable_user_id: string | null
	updated_at: string
}

type OverrideFlagRow = {
	flag_key: string
	user_id: number
	enabled: number
	updated_at: string
	username: string
	stable_user_id: string
}

type OverrideEnabledRow = {
	flag_key: string
	enabled: number
}

/**
 * Deterministic 0–99 bucket for percentage rollouts. Exported for tests.
 */
export function computeRolloutBucket(key: string, userId: number): number {
	return fnv1a32(`${key}:${userId}`) % 100
}

/**
 * How a flag's evaluated value was assigned. Recorded with success-metric
 * exposures so readouts can compare only fairly assigned cohorts: `override`
 * users are hand-picked (selection bias) and are excluded from on/off
 * comparisons, while `rollout` users are deterministically bucketed.
 */
export type FeatureFlagAssignmentSource =
	| 'override'
	| 'global'
	| 'rollout'
	| 'default'

export type FeatureFlagEvaluation = {
	enabled: boolean
	source: FeatureFlagAssignmentSource
}

function evaluateFlagState(input: {
	key: string
	userId: number | null
	overrideEnabled: boolean | null
	global: { enabled: boolean; rolloutPercent: number | null } | null
	defaultEnabled: boolean
}): FeatureFlagEvaluation {
	if (input.overrideEnabled !== null) {
		return { enabled: input.overrideEnabled, source: 'override' }
	}
	if (input.global) {
		if (!input.global.enabled) return { enabled: false, source: 'global' }
		if (input.global.rolloutPercent === null) {
			return { enabled: true, source: 'global' }
		}
		if (input.userId === null) return { enabled: false, source: 'rollout' }
		return {
			enabled:
				computeRolloutBucket(input.key, input.userId) <
				input.global.rolloutPercent,
			source: 'rollout',
		}
	}
	return { enabled: input.defaultEnabled, source: 'default' }
}

function assertValidRolloutPercent(rolloutPercent: number | null) {
	if (rolloutPercent === null) return
	if (
		!Number.isInteger(rolloutPercent) ||
		rolloutPercent < 0 ||
		rolloutPercent > 100
	) {
		throw new Error('rolloutPercent must be an integer between 0 and 100.')
	}
}

function normalizeFeatureFlagNote(note: unknown): string | null {
	if (note === undefined) {
		return null
	}
	if (typeof note !== 'string') {
		throw new Error('note must be a string.')
	}
	const trimmed = note.trim()
	if (trimmed.length > maxFeatureFlagNoteLength) {
		throw new Error(
			`note must be at most ${maxFeatureFlagNoteLength} characters.`,
		)
	}
	return trimmed
}

export async function isFeatureEnabled(
	db: D1Database,
	key: FeatureFlagKey,
	userId: number | null,
): Promise<boolean> {
	if (userId !== null) {
		const override = await db
			.prepare(
				`SELECT enabled
				 FROM feature_flag_user_overrides
				 WHERE flag_key = ? AND user_id = ?`,
			)
			.bind(key, userId)
			.first<{ enabled: number }>()
		if (override) {
			return override.enabled === 1
		}
	}

	const global = await db
		.prepare(
			`SELECT enabled, rollout_percent
			 FROM feature_flags
			 WHERE key = ?`,
		)
		.bind(key)
		.first<{ enabled: number; rollout_percent: number | null }>()

	return evaluateFlagState({
		key,
		userId,
		overrideEnabled: null,
		global: global
			? {
					enabled: global.enabled === 1,
					rolloutPercent: global.rollout_percent,
				}
			: null,
		defaultEnabled: getFeatureFlagDefinition(key).defaultEnabled,
	}).enabled
}

export async function getFeatureFlagEvaluationsForUser(
	db: D1Database,
	userId: number | null,
): Promise<Record<FeatureFlagKey, FeatureFlagEvaluation>> {
	const globalResult = await db
		.prepare(
			`SELECT key, enabled, rollout_percent
			 FROM feature_flags`,
		)
		.all<{ key: string; enabled: number; rollout_percent: number | null }>()
	const globalByKey = new Map(
		(globalResult.results ?? []).map((row) => [row.key, row]),
	)

	const overrideByKey = new Map<string, boolean>()
	if (userId !== null) {
		const overrideResult = await db
			.prepare(
				`SELECT flag_key, enabled
				 FROM feature_flag_user_overrides
				 WHERE user_id = ?`,
			)
			.bind(userId)
			.all<OverrideEnabledRow>()
		for (const row of overrideResult.results ?? []) {
			overrideByKey.set(row.flag_key, row.enabled === 1)
		}
	}

	const evaluations = {} as Record<FeatureFlagKey, FeatureFlagEvaluation>
	for (const key of featureFlagKeys) {
		const global = globalByKey.get(key)
		const overrideEnabled = overrideByKey.has(key)
			? (overrideByKey.get(key) ?? false)
			: null
		evaluations[key] = evaluateFlagState({
			key,
			userId,
			overrideEnabled,
			global: global
				? {
						enabled: global.enabled === 1,
						rolloutPercent: global.rollout_percent,
					}
				: null,
			defaultEnabled: getFeatureFlagDefinition(key).defaultEnabled,
		})
	}
	return evaluations
}

export async function getFeatureFlagsForUser(
	db: D1Database,
	userId: number | null,
): Promise<Record<FeatureFlagKey, boolean>> {
	const evaluations = await getFeatureFlagEvaluationsForUser(db, userId)
	const flags = {} as Record<FeatureFlagKey, boolean>
	for (const key of featureFlagKeys) {
		flags[key] = evaluations[key].enabled
	}
	return flags
}

export async function setFeatureFlagGlobalState(
	db: D1Database,
	input: {
		key: FeatureFlagKey
		enabled: boolean
		rolloutPercent: number | null
		note?: unknown
		updatedBy: number
	},
): Promise<void> {
	assertValidRolloutPercent(input.rolloutPercent)
	// null note = "leave unchanged" on update ('' on first insert); callers
	// omit the field to preserve an existing operator note.
	const note = normalizeFeatureFlagNote(input.note)
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled, rollout_percent, note, updated_by, updated_at)
			 VALUES (?, ?, ?, COALESCE(?, ''), ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(key) DO UPDATE SET
				enabled = excluded.enabled,
				rollout_percent = excluded.rollout_percent,
				note = COALESCE(?, feature_flags.note),
				updated_by = excluded.updated_by,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.key,
			input.enabled ? 1 : 0,
			input.rolloutPercent,
			note,
			input.updatedBy,
			note,
		)
		.run()
}

export async function setFeatureFlagUserOverride(
	db: D1Database,
	input: {
		key: FeatureFlagKey
		userId: number
		enabled: boolean
		updatedBy: number
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled, updated_by, updated_at)
			 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(flag_key, user_id) DO UPDATE SET
				enabled = excluded.enabled,
				updated_by = excluded.updated_by,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(input.key, input.userId, input.enabled ? 1 : 0, input.updatedBy)
		.run()
}

export async function clearFeatureFlagUserOverride(
	db: D1Database,
	input: { key: FeatureFlagKey; userId: number },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM feature_flag_user_overrides
			 WHERE flag_key = ? AND user_id = ?`,
		)
		.bind(input.key, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listFeatureFlagsForAdmin(
	db: D1Database,
): Promise<Array<AdminFeatureFlag>> {
	const globalResult = await db
		.prepare(
			`SELECT f.key, f.enabled, f.rollout_percent, f.note,
				u.stable_user_id AS updated_by_stable_user_id, f.updated_at
			 FROM feature_flags f
			 LEFT JOIN users u ON u.id = f.updated_by`,
		)
		.all<GlobalFlagRow>()
	const globalByKey = new Map(
		(globalResult.results ?? []).map((row) => [row.key, row]),
	)

	const overrideResult = await db
		.prepare(
			`SELECT o.flag_key, o.user_id, o.enabled, o.updated_at, u.username,
				u.stable_user_id
			 FROM feature_flag_user_overrides o
			 JOIN users u ON u.id = o.user_id
			 ORDER BY o.flag_key ASC, u.username ASC`,
		)
		.all<OverrideFlagRow>()
	const overridesByKey = new Map<
		string,
		Array<AdminFeatureFlag['overrides'][number]>
	>()
	for (const row of overrideResult.results ?? []) {
		const list = overridesByKey.get(row.flag_key) ?? []
		list.push({
			stableUserId: row.stable_user_id,
			username: row.username,
			enabled: row.enabled === 1,
			updatedAt: row.updated_at,
		})
		overridesByKey.set(row.flag_key, list)
	}

	const flags: Array<AdminFeatureFlag> = []
	const seenKeys = new Set<string>()

	for (const definition of featureFlagDefinitions) {
		seenKeys.add(definition.key)
		const global = globalByKey.get(definition.key)
		flags.push({
			key: definition.key,
			description: definition.description,
			defaultEnabled: definition.defaultEnabled,
			stale: false,
			successMetric:
				getFeatureFlagDefinition(definition.key).successMetric ?? null,
			global: global
				? {
						enabled: global.enabled === 1,
						rolloutPercent: global.rollout_percent,
						note: global.note,
						updatedByStableUserId: global.updated_by_stable_user_id,
						updatedAt: global.updated_at,
					}
				: null,
			overrides: overridesByKey.get(definition.key) ?? [],
		})
	}

	const staleKeys = new Set<string>()
	for (const key of globalByKey.keys()) {
		if (!seenKeys.has(key)) staleKeys.add(key)
	}
	for (const key of overridesByKey.keys()) {
		if (!seenKeys.has(key)) staleKeys.add(key)
	}

	for (const key of [...staleKeys].sort()) {
		const global = globalByKey.get(key)
		flags.push({
			key,
			description: null,
			defaultEnabled: null,
			stale: true,
			successMetric: null,
			global: global
				? {
						enabled: global.enabled === 1,
						rolloutPercent: global.rollout_percent,
						note: global.note,
						updatedByStableUserId: global.updated_by_stable_user_id,
						updatedAt: global.updated_at,
					}
				: null,
			overrides: overridesByKey.get(key) ?? [],
		})
	}

	return flags
}

export async function deleteStaleFeatureFlag(
	db: D1Database,
	key: string,
): Promise<boolean> {
	if (isFeatureFlagKey(key)) {
		throw new Error(
			`Cannot delete registry feature flag "${key}". Remove it from the code registry first.`,
		)
	}

	const results = await db.batch([
		db
			.prepare(`DELETE FROM feature_flag_user_overrides WHERE flag_key = ?`)
			.bind(key),
		db.prepare(`DELETE FROM feature_flags WHERE key = ?`).bind(key),
	])

	return (
		(results[0]?.meta.changes ?? 0) > 0 || (results[1]?.meta.changes ?? 0) > 0
	)
}
