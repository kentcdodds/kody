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
	const invalid = [
		null,
		'nope',
		{ ...validInput(), whatHappened: '' },
		{
			...validInput(),
			whatHappened: 'x'.repeat(retrospectiveFieldMaxChars + 1),
		},
		{ ...validInput(), timeline: [] },
		{ ...validInput(), timeline: [{ at: '  ', note: 'note' }] },
	]
	expect(
		invalid.map((value) => parseIncidentRetrospectiveInput(value).ok),
	).toEqual(invalid.map(() => false))

	const parsed = parseIncidentRetrospectiveInput({
		...validInput(),
		whatHappened: '  trimmed  ',
		publishedAt: 'should-be-ignored',
	})
	if (!parsed.ok) throw new Error(parsed.message)
	expect(parsed.retrospective.whatHappened).toBe('trimmed')
	const stamped = stampIncidentRetrospective(
		parsed.retrospective,
		Date.parse('2026-09-02T22:00:00.000Z'),
	)
	expect(stamped.publishedAt).toBe('2026-09-02T22:00:00.000Z')

	const serialized = serializeIncidentRetrospective(stamped)
	expect(parseStoredIncidentRetrospective(serialized)).toEqual(stamped)
	for (const stored of [null, '{', JSON.stringify(validInput())]) {
		expect(parseStoredIncidentRetrospective(stored)).toBeNull()
	}

	const startedAt = Date.parse('2026-09-02T21:57:54.765Z')
	const resolvedAt = Date.parse('2026-09-02T22:00:51.866Z')
	const jobsRow = (retrospective: string | null) => ({
		id: 10,
		component: 'jobs',
		started_at: startedAt,
		resolved_at: resolvedAt,
		detail: 'error',
		retrospective,
	})
	expect(incidentRowToView(jobsRow(null))).toEqual({
		id: 10,
		component: 'jobs',
		componentName: 'Jobs',
		startedAt: '2026-09-02T21:57:54.765Z',
		resolvedAt: '2026-09-02T22:00:51.866Z',
		detail: 'error',
		retrospective: null,
	})
	expect(
		incidentRowToView({ ...jobsRow(null), id: 99, component: 'audit_db' }),
	).toBeNull()
	expect(incidentRowToView(jobsRow(serialized))?.retrospective).toEqual(stamped)

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
	const hasColumn = () =>
		incidentsTableHasRetrospectiveColumn(
			db.prepare('PRAGMA table_info(incidents)').all() as Array<{
				name: string
			}>,
		)
	expect(hasColumn()).toBe(false)
	db.exec(addIncidentRetrospectiveColumnSql)
	expect(hasColumn()).toBe(true)

	db.prepare(
		`INSERT INTO incidents (id, component, started_at, resolved_at, detail)
		VALUES (10, 'jobs', ?, ?, 'error')`,
	).run(startedAt, resolvedAt)
	db.prepare(
		`INSERT INTO incidents (id, component, started_at, resolved_at, detail)
		VALUES (11, 'jobs', ?, NULL, 'error')`,
	).run(Date.parse('2026-09-02T23:00:00.000Z'))

	const update = db.prepare(updateIncidentRetrospectiveSql)
	expect(update.run(serialized, 10).changes).toBe(1)
	expect(update.run(serialized, 11).changes).toBe(0)

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
})
