import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	addIncidentRetrospectiveColumnSql,
	incidentRowToView,
	incidentsTableHasRetrospectiveColumn,
	parseIncidentRetrospectiveInput,
	parseStoredIncidentRetrospective,
	retrospectiveFieldMaxChars,
	selectIncidentByIdSql,
	serializeIncidentRetrospective,
	stampIncidentRetrospective,
	updateIncidentRetrospectiveSql,
} from './retrospective.ts'

const jobsRetrospectivePath = join(
	dirname(fileURLToPath(import.meta.url)),
	'retrospectives/jobs-2026-09-02.json',
)

function validInput() {
	return {
		whatHappened: 'Probes failed twice.',
		impact: 'Status page showed Jobs down.',
		timeline: [{ at: '2026-09-02T21:57:54.765Z', note: 'Incident opened.' }],
		cause: 'Unconfirmed.',
		whatWeDid: 'Waited for probes to recover.',
		whatWeWillChange: 'Publish a retrospective.',
	}
}

test('retrospective parse, store mapping, and schema upgrade keep probe incidents valid without a narrative', () => {
	expect(parseIncidentRetrospectiveInput(null).ok).toBe(false)
	expect(parseIncidentRetrospectiveInput('nope').ok).toBe(false)
	expect(
		parseIncidentRetrospectiveInput({ ...validInput(), whatHappened: '' }).ok,
	).toBe(false)
	expect(
		parseIncidentRetrospectiveInput({
			...validInput(),
			whatHappened: 'x'.repeat(retrospectiveFieldMaxChars + 1),
		}).ok,
	).toBe(false)
	expect(
		parseIncidentRetrospectiveInput({ ...validInput(), timeline: [] }).ok,
	).toBe(false)
	expect(
		parseIncidentRetrospectiveInput({
			...validInput(),
			timeline: [{ at: '  ', note: 'note' }],
		}).ok,
	).toBe(false)

	const parsed = parseIncidentRetrospectiveInput({
		...validInput(),
		whatHappened: '  trimmed  ',
		publishedAt: 'should-be-ignored',
	})
	if (!parsed.ok) throw new Error(parsed.message)
	expect(parsed.retrospective.whatHappened).toBe('trimmed')
	const publishedAtMs = Date.parse('2026-09-02T22:00:00.000Z')
	const stamped = stampIncidentRetrospective(
		parsed.retrospective,
		publishedAtMs,
	)
	expect(stamped.publishedAt).toBe('2026-09-02T22:00:00.000Z')

	const stored = parseStoredIncidentRetrospective(
		serializeIncidentRetrospective(stamped),
	)
	expect(stored).toEqual(stamped)
	expect(parseStoredIncidentRetrospective(null)).toBeNull()
	expect(parseStoredIncidentRetrospective('{')).toBeNull()
	expect(
		parseStoredIncidentRetrospective(JSON.stringify(validInput())),
	).toBeNull()

	const withoutNarrative = incidentRowToView({
		id: 10,
		component: 'jobs',
		started_at: Date.parse('2026-09-02T21:57:54.765Z'),
		resolved_at: Date.parse('2026-09-02T22:00:51.866Z'),
		detail: 'error',
		retrospective: null,
	})
	expect(withoutNarrative).toEqual({
		id: 10,
		component: 'jobs',
		componentName: 'Jobs',
		startedAt: '2026-09-02T21:57:54.765Z',
		resolvedAt: '2026-09-02T22:00:51.866Z',
		detail: 'error',
		retrospective: null,
	})
	expect(
		incidentRowToView({
			id: 99,
			component: 'audit_db',
			started_at: 1,
			resolved_at: 2,
			detail: 'retired',
			retrospective: null,
		}),
	).toBeNull()

	const withNarrative = incidentRowToView({
		id: 10,
		component: 'jobs',
		started_at: Date.parse('2026-09-02T21:57:54.765Z'),
		resolved_at: Date.parse('2026-09-02T22:00:51.866Z'),
		detail: 'error',
		retrospective: serializeIncidentRetrospective(stamped),
	})
	expect(withNarrative?.retrospective).toEqual(stamped)

	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE incidents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			component TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			resolved_at INTEGER,
			detail TEXT
		)
	`)
	const before = db.prepare('PRAGMA table_info(incidents)').all() as Array<{
		name: string
	}>
	expect(incidentsTableHasRetrospectiveColumn(before)).toBe(false)
	db.exec(addIncidentRetrospectiveColumnSql)
	const after = db.prepare('PRAGMA table_info(incidents)').all() as Array<{
		name: string
	}>
	expect(incidentsTableHasRetrospectiveColumn(after)).toBe(true)

	db.prepare(
		`INSERT INTO incidents (id, component, started_at, resolved_at, detail)
		VALUES (10, 'jobs', ?, ?, 'error')`,
	).run(
		Date.parse('2026-09-02T21:57:54.765Z'),
		Date.parse('2026-09-02T22:00:51.866Z'),
	)
	db.prepare(
		`INSERT INTO incidents (id, component, started_at, resolved_at, detail)
		VALUES (11, 'jobs', ?, NULL, 'error')`,
	).run(Date.parse('2026-09-02T23:00:00.000Z'))

	const resolvedUpdate = db
		.prepare(updateIncidentRetrospectiveSql)
		.run(serializeIncidentRetrospective(stamped), 10)
	expect(resolvedUpdate.changes).toBe(1)
	const openUpdate = db
		.prepare(updateIncidentRetrospectiveSql)
		.run(serializeIncidentRetrospective(stamped), 11)
	expect(openUpdate.changes).toBe(0)

	const loaded = db.prepare(selectIncidentByIdSql).get(10) as {
		retrospective: string
	}
	expect(parseStoredIncidentRetrospective(loaded.retrospective)).toEqual(
		stamped,
	)

	const jobsPayload = JSON.parse(
		readFileSync(jobsRetrospectivePath, 'utf8'),
	) as unknown
	const jobsParsed = parseIncidentRetrospectiveInput(jobsPayload)
	if (!jobsParsed.ok) throw new Error(jobsParsed.message)
	expect(jobsParsed.retrospective.timeline.length).toBeGreaterThan(3)
	expect(jobsParsed.retrospective.whatHappened).toMatch(/incident 10/i)
	expect(jobsParsed.retrospective.cause).toMatch(/No confirmed root cause/)
	expect(jobsParsed.retrospective.whatWeDid).toMatch(/not finishing #2010/)
	expect(jobsParsed.retrospective.whatWeWillChange).toMatch(/Do not split/)
})
