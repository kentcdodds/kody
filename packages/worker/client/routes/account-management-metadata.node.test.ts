import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	IdValue,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'

/**
 * `css()` emits one `@layer rmx.<class> { .<class> { … } }` block per class, so
 * a rendered element's rules can be read back from the same markup.
 */
function readRulesFor(html: string, element: string) {
	const className = new RegExp(`<${element}[^>]*class="(rmxc-[^"]+)"`).exec(
		html,
	)?.[1]
	if (!className) throw new Error(`No ${element} with a css() class in output`)
	const rules = new RegExp(
		`@layer rmx\\.${className} \\{ \\.${className} \\{([^}]*)\\}`,
	).exec(html)?.[1]
	if (!rules) throw new Error(`No rules emitted for .${className}`)
	return rules
}

test('a metadata band sizes its own columns and renders an id as a single-line copy target', async () => {
	const packageId = '0f8f7f1e-5a2b-4c3d-9e1f-2a3b4c5d6e7f'
	const html = await renderToString(
		jsx(MetadataGrid, {
			items: [
				{
					label: 'Package id',
					value: jsx(IdValue, { value: packageId, label: 'package id' }),
				},
				{
					label: 'Created',
					value: jsx(TimestampValue, { value: '2026-08-07 10:11:12' }),
				},
				{ label: 'Deleted', value: jsx(TimestampValue, { value: null }) },
			],
		}),
	)

	// Columns come from the container, not from a per-page count — this is what
	// stops a 434px detail pane from dividing itself into 115px columns.
	expect(readRulesFor(html, 'dl')).toContain(
		'grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
	)

	// The id clips in CSS and keeps the whole value in the DOM, so a screen
	// reader still reads it out and a selection still copies it whole.
	expect(html).toContain(`>${packageId}</code>`)
	const idRules = readRulesFor(html, 'code')
	expect(idRules).toContain('white-space: nowrap')
	expect(idRules).toContain('text-overflow: ellipsis')
	expect(idRules).toContain('overflow: hidden')

	// A band carries one copy button per id, so each has to say which id it takes.
	expect(html).toContain('aria-label="Copy package id"')

	// A missing timestamp still reads as an absent value rather than an epoch.
	expect(html).toContain('>—</span>')
})

test('a timestamp stays on one line with tabular figures, and falls back when absent', async () => {
	const html = await renderToString(
		jsx(TimestampValue, { value: '2026-08-07 10:11:12' }),
	)
	const rules = readRulesFor(html, 'span')
	expect(rules).toContain('white-space: nowrap')
	expect(rules).toContain('font-variant-numeric: tabular-nums')

	const missing = await renderToString(
		jsx(TimestampValue, { value: null, fallback: 'Unknown' }),
	)
	expect(missing).toContain('>Unknown</span>')
})
