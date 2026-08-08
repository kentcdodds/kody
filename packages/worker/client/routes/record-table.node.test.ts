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

test('record table keeps container drops, row links, and expand/pane selection contracts', async () => {
	const noneHtml = await renderToString(
		jsx(RecordTable, { mode: 'none', ariaLabel: 'Packages', columns, rows }),
	)

	// These tables live inside a 200px-railed shell, so the viewport says very
	// little about how much room the table actually has. A `@media` rule here
	// would drop a column on a wide screen and keep one in a narrow pane.
	expect(noneHtml).toContain('@container (max-width: 780px)')
	expect(noneHtml).not.toMatch(/@media \(max-width: \d+px\)/)
	expect(noneHtml).toContain('data-label="Kody id"')
	expect(noneHtml).toContain('data-primary="true"')

	// none mode ignores selection even when an id and record are passed.
	const noneWithSelection = await renderToString(
		jsx(RecordTable, {
			mode: 'none',
			ariaLabel: 'Entitlements',
			columns,
			rows,
			selectedId: 'a',
			record: jsx('p', { children: 'should not render' }),
		}),
	)
	expect(noneWithSelection).not.toContain('data-selected="true"')
	expect(noneWithSelection).not.toContain('should not render')

	const expandHtml = await renderToString(
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
	expect(expandHtml).toContain('href="/account/packages/b"')
	expect(expandHtml).toContain('data-prevent-scroll-reset')
	expect(expandHtml).toContain('aria-expanded="true"')
	expect(expandHtml).toContain('aria-expanded="false"')
	const controls = /aria-controls="([^"]+)"/.exec(expandHtml)?.[1]
	expect(controls).toBeTruthy()
	expect(expandHtml).toContain(`id="${controls}"`)
	expect(expandHtml).toContain('Beta record')
	expect(expandHtml.match(/data-selected="true"/g)).toHaveLength(1)
	expect(expandHtml.match(/data-record-row="true"/g)).toHaveLength(1)

	// Selected without a loaded record must not point assistive tech at a
	// missing expanded region.
	const expandPending = await renderToString(
		jsx(RecordTable, {
			mode: 'expand',
			ariaLabel: 'Packages',
			columns,
			rows,
			selectedId: 'b',
		}),
	)
	expect(expandPending).not.toContain('aria-expanded="true"')
	expect(expandPending).not.toContain('aria-controls')
	expect(expandPending).not.toContain('data-record-row="true"')

	const paneHtml = await renderToString(
		jsx(RecordTable, {
			mode: 'pane',
			ariaLabel: 'Secrets',
			columns,
			rows,
			selectedId: 'a',
			record: jsx('p', { children: 'Alpha editor' }),
		}),
	)
	expect(paneHtml).not.toContain('data-record-row="true"')
	expect(paneHtml.indexOf('Alpha editor')).toBeGreaterThan(
		paneHtml.indexOf('</table>'),
	)
	expect(paneHtml).toContain('data-selected="true"')

	// Off-window expand selection falls back to a pane after the table.
	const orphanHtml = await renderToString(
		jsx(RecordTable, {
			mode: 'expand',
			ariaLabel: 'Runs',
			columns,
			rows,
			selectedId: 'not-in-this-window',
			record: jsx('p', { children: 'Orphan record' }),
		}),
	)
	expect(orphanHtml).toContain('Orphan record')
	expect(orphanHtml).not.toContain('data-record-row="true"')
	expect(orphanHtml.indexOf('Orphan record')).toBeGreaterThan(
		orphanHtml.indexOf('</table>'),
	)
})

test('record table empty and busy states keep toolbar layout stable', async () => {
	const emptyHtml = await renderToString(
		jsx(RecordTable, {
			mode: 'pane',
			ariaLabel: 'Secrets',
			columns,
			rows: [],
			emptyLabel: 'No secrets yet.',
			countLabel: '0 of 0 shown',
		}),
	)

	expect(emptyHtml).toContain('No secrets yet.')
	expect(emptyHtml).toContain('0 of 0 shown')
	expect(emptyHtml).not.toContain('<table')
	expect(emptyHtml).toContain('<section aria-label="Secrets"')

	const busyHtml = await renderToString(
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
	// instead.
	expect(busyHtml).toContain('aria-busy="true"')
	expect(busyHtml).toContain('data-busy="true"')
	expect(busyHtml).toContain('2 of 2 shown')
	expect(busyHtml).toContain('aria-live="polite"')
	expect(busyHtml).toContain('Updating…')
	expect(busyHtml).toContain('<table')
	expect(busyHtml).toContain('Alpha')
})
