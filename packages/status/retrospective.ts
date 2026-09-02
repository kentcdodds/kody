/**
 * Operator-authored narrative attached to a probe-derived incident.
 * Open/resolve stays probe-driven; this is optional public writeup, not a
 * second incident system.
 */

import {
	isStatusComponentId,
	statusComponentName,
	type IncidentView,
} from './status-types.ts'

export const incidentRetrospectiveColumn = 'retrospective'

export const retrospectiveFieldMaxChars = 2_000
export const retrospectiveTimelineNoteMaxChars = 500
export const retrospectiveTimelineAtMaxChars = 80
export const retrospectiveTimelineMaxEntries = 24

export type RetrospectiveTimelineEntry = {
	at: string
	note: string
}

export type IncidentRetrospectiveInput = {
	whatHappened: string
	impact: string
	timeline: Array<RetrospectiveTimelineEntry>
	cause: string
	whatWeDid: string
	whatWeWillChange: string
}

export type IncidentRetrospective = IncidentRetrospectiveInput & {
	publishedAt: string
}

export type RetrospectiveParseError =
	| 'not-object'
	| 'invalid-field'
	| 'empty-field'
	| 'too-long'
	| 'invalid-timeline'

export type RetrospectiveParseResult =
	| { ok: true; retrospective: IncidentRetrospectiveInput }
	| { ok: false; error: RetrospectiveParseError; message: string }

const requiredTextFields = [
	'whatHappened',
	'impact',
	'cause',
	'whatWeDid',
	'whatWeWillChange',
] as const

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null
	}
	return value as Record<string, unknown>
}

function readTrimmedString(
	value: unknown,
	field: string,
	maxChars: number,
):
	| { ok: true; value: string }
	| { ok: false; result: RetrospectiveParseResult } {
	if (typeof value !== 'string') {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'invalid-field',
				message: `${field} must be a string`,
			},
		}
	}
	const trimmed = value.trim()
	if (!trimmed) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'empty-field',
				message: `${field} must not be empty`,
			},
		}
	}
	if (trimmed.length > maxChars) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'too-long',
				message: `${field} must be at most ${maxChars} characters`,
			},
		}
	}
	return { ok: true, value: trimmed }
}

function parseTimeline(
	value: unknown,
):
	| { ok: true; timeline: Array<RetrospectiveTimelineEntry> }
	| { ok: false; result: RetrospectiveParseResult } {
	if (!Array.isArray(value)) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'invalid-timeline',
				message: 'timeline must be an array',
			},
		}
	}
	if (value.length === 0 || value.length > retrospectiveTimelineMaxEntries) {
		return {
			ok: false,
			result: {
				ok: false,
				error: 'invalid-timeline',
				message: `timeline must have 1–${retrospectiveTimelineMaxEntries} entries`,
			},
		}
	}
	const timeline: Array<RetrospectiveTimelineEntry> = []
	for (const [index, entry] of value.entries()) {
		const record = asRecord(entry)
		if (!record) {
			return {
				ok: false,
				result: {
					ok: false,
					error: 'invalid-timeline',
					message: `timeline[${index}] must be an object`,
				},
			}
		}
		const at = readTrimmedString(
			record.at,
			`timeline[${index}].at`,
			retrospectiveTimelineAtMaxChars,
		)
		if (!at.ok) return { ok: false, result: at.result }
		const note = readTrimmedString(
			record.note,
			`timeline[${index}].note`,
			retrospectiveTimelineNoteMaxChars,
		)
		if (!note.ok) return { ok: false, result: note.result }
		timeline.push({ at: at.value, note: note.value })
	}
	return { ok: true, timeline }
}

/** Validates an operator write body. Ignores publishedAt; the store stamps it. */
export function parseIncidentRetrospectiveInput(
	value: unknown,
): RetrospectiveParseResult {
	const record = asRecord(value)
	if (!record) {
		return {
			ok: false,
			error: 'not-object',
			message: 'body must be an object',
		}
	}
	const fields: Partial<IncidentRetrospectiveInput> = {}
	for (const field of requiredTextFields) {
		const parsed = readTrimmedString(
			record[field],
			field,
			retrospectiveFieldMaxChars,
		)
		if (!parsed.ok) return parsed.result
		fields[field] = parsed.value
	}
	const timeline = parseTimeline(record.timeline)
	if (!timeline.ok) return timeline.result
	return {
		ok: true,
		retrospective: {
			whatHappened: fields.whatHappened!,
			impact: fields.impact!,
			timeline: timeline.timeline,
			cause: fields.cause!,
			whatWeDid: fields.whatWeDid!,
			whatWeWillChange: fields.whatWeWillChange!,
		},
	}
}

export function stampIncidentRetrospective(
	input: IncidentRetrospectiveInput,
	publishedAtMs: number,
): IncidentRetrospective {
	return {
		...input,
		publishedAt: new Date(publishedAtMs).toISOString(),
	}
}

export function serializeIncidentRetrospective(
	retrospective: IncidentRetrospective,
): string {
	return JSON.stringify(retrospective)
}

/** Stored JSON that cannot be parsed is dropped so a bad write cannot 500 the page. */
export function parseStoredIncidentRetrospective(
	raw: string | null | undefined,
): IncidentRetrospective | null {
	if (typeof raw !== 'string' || !raw.trim()) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw) as unknown
	} catch {
		return null
	}
	const input = parseIncidentRetrospectiveInput(parsed)
	if (!input.ok) return null
	const record = asRecord(parsed)
	const publishedAt =
		typeof record?.publishedAt === 'string' && record.publishedAt.trim()
			? record.publishedAt.trim()
			: null
	if (!publishedAt) return null
	return { ...input.retrospective, publishedAt }
}

export function incidentsTableHasRetrospectiveColumn(
	columns: ReadonlyArray<{ name: string }>,
): boolean {
	return columns.some((column) => column.name === incidentRetrospectiveColumn)
}

export const addIncidentRetrospectiveColumnSql = `ALTER TABLE incidents ADD COLUMN ${incidentRetrospectiveColumn} TEXT`

export const selectIncidentByIdSql = `SELECT id, component, started_at, resolved_at, detail, retrospective
FROM incidents WHERE id = ?`

export const updateIncidentRetrospectiveSql = `UPDATE incidents SET retrospective = ?
WHERE id = ? AND resolved_at IS NOT NULL`

export type IncidentRow = {
	id: number
	component: string
	started_at: number
	resolved_at: number | null
	detail: string | null
	retrospective: string | null
}

export function incidentRowToView(row: IncidentRow): IncidentView | null {
	if (!isStatusComponentId(row.component)) return null
	return {
		id: row.id,
		component: row.component,
		componentName: statusComponentName(row.component),
		startedAt: new Date(row.started_at).toISOString(),
		resolvedAt:
			row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
		detail: row.detail,
		retrospective: parseStoredIncidentRetrospective(row.retrospective),
	}
}
