import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	RecordTable,
	type RecordTableColumn,
} from '#client/routes/record-table.tsx'

const columns: Array<RecordTableColumn> = [
	{ key: 'name', label: 'Name', primary: true },
	{ key: 'kodyId', label: 'Kody id', drop: 2 },
	{ key: 'count', label: 'Count', align: 'end' },
]

const rows = [
	{
		id: 'a',
		href: '/account/packages/a',
		cells: { name: 'Alpha', count: '3' },
	},
	{ id: 'b', href: '/account/packages/b', cells: { name: 'Beta', count: '7' } },
]

test('a dropped column hides on the container, not the viewport', async () => {
	const html = await renderToString(
		jsx(RecordTable, { mode: 'none', ariaLabel: 'Packages', columns, rows }),
	)

	// These tables live inside a 200px-railed shell, so the viewport says very
	// little about how much room the table actually has. A `@media` rule here
	// would drop a column on a wide screen and keep one in a narrow pane.
	expect(html).toContain('@container (max-width: 780px)')
	expect(html).not.toMatch(/@media \(max-width: \d+px\)/)

	// Every cell carries its own label so the sub-620px card fallback can
	// render one without duplicating the row in the DOM.
	expect(html).toContain('data-label="Kody id"')
	expect(html).toContain('data-primary="true"')
})

test('the primary cell is the row link and reports the expansion it controls', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'expand',
			ariaLabel: 'Packages',
			columns,
			rows,
			selectedId: 'b',
			record: jsx('p', { children: 'Beta record' }),
		}),
	)

	// Rows stay real anchors, so the selected record is in the URL and the
	// scroll-preserving navigation keeps working.
	expect(html).toContain('href="/account/packages/b"')
	expect(html).toContain('data-prevent-scroll-reset')
	expect(html).toContain('aria-expanded="true"')
	expect(html).toContain('aria-expanded="false"')

	// `aria-controls` has to name the row that actually holds the record.
	const controls = /aria-controls="([^"]+)"/.exec(html)?.[1]
	expect(controls).toBeTruthy()
	expect(html).toContain(`id="${controls}"`)
	expect(html).toContain('Beta record')

	// Only the selected row is marked, and only it unfolds.
	expect(html.match(/data-selected="true"/g)).toHaveLength(1)
	expect(html.match(/data-record-row="true"/g)).toHaveLength(1)
})

test('pane mode puts the record after the table instead of inside it', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'pane',
			ariaLabel: 'Secrets',
			columns,
			rows,
			selectedId: 'a',
			record: jsx('p', { children: 'Alpha editor' }),
		}),
	)

	// The attribute names also appear inside the emitted `@layer` selectors,
	// so these assertions have to match the markup form, not the bare name.
	expect(html).not.toContain('data-record-row="true"')
	expect(html.indexOf('Alpha editor')).toBeGreaterThan(html.indexOf('</table>'))
	// The row is still marked so the editor below has a visible anchor.
	expect(html).toContain('data-selected="true"')
})

test('a table with no rows shows its empty copy instead of a bare header', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'pane',
			ariaLabel: 'Secrets',
			columns,
			rows: [],
			emptyLabel: 'No secrets yet.',
			countLabel: '0 of 0 shown',
		}),
	)

	expect(html).toContain('No secrets yet.')
	expect(html).toContain('0 of 0 shown')
	expect(html).not.toContain('<table')
	// An empty collection renders no table, so the region has to carry the
	// name or the toolbar and count sit in an unnamed part of the page.
	expect(html).toContain('<section aria-label="Secrets"')
})

test('none mode renders no selection, even when an id is passed', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'none',
			ariaLabel: 'Entitlements',
			columns,
			rows,
			selectedId: 'a',
			record: jsx('p', { children: 'should not render' }),
		}),
	)

	expect(html).not.toContain('data-selected="true"')
	expect(html).not.toContain('should not render')
})

test('a refetch reports itself in the toolbar instead of above the table', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'pane',
			ariaLabel: 'Packages',
			columns,
			rows,
			countLabel: '2 of 2 shown',
			busy: true,
		}),
	)

	// A page-level "Loading…" line above the table reflowed everything below it
	// on every keystroke of a search that refetches. The count dims in place
	// instead — replacing its text would resize the search field beside it,
	// which is the box the reader is typing into.
	expect(html).toContain('aria-busy="true"')
	expect(html).toContain('data-busy="true"')
	expect(html).toContain('2 of 2 shown')
	// The announcement is out of flow, so it costs no layout.
	expect(html).toContain('aria-live="polite"')
	expect(html).toContain('Updating…')
	// The rows stay put while the refetch is in flight.
	expect(html).toContain('<table')
	expect(html).toContain('Alpha')
})

test('a selected row with no record yet claims no expanded region', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'expand',
			ariaLabel: 'Packages',
			columns,
			rows,
			selectedId: 'b',
		}),
	)

	// The detail is still loading (or 404'd), so there is no record row —
	// reporting one would point assistive tech at an id that is not in the DOM.
	expect(html).not.toContain('aria-expanded="true"')
	expect(html).not.toContain('aria-controls')
	expect(html).not.toContain('data-record-row="true"')
})

test('expand mode falls back to a pane when the selected row is off the window', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'expand',
			ariaLabel: 'Runs',
			columns,
			rows,
			// A deep link, a filter change, or paging past the selection: the
			// record is loaded but has no row to unfold under.
			selectedId: 'not-in-this-window',
			record: jsx('p', { children: 'Orphan record' }),
		}),
	)

	expect(html).toContain('Orphan record')
	expect(html).not.toContain('data-record-row="true"')
	// It renders after the table rather than vanishing.
	expect(html.indexOf('Orphan record')).toBeGreaterThan(
		html.indexOf('</table>'),
	)
})
