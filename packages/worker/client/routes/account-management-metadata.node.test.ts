import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AdminCommunityReportsRoute } from '#client/routes/admin-community-reports.tsx'
import {
	AccountManagementInlineLinkNav,
	AccountManagementLinkNav,
	AccountPageHeader,
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

test('metadata band auto-fits columns and keeps id/timestamp values copyable and single-line', async () => {
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
	expect(html).toContain('aria-label="Copy package id"')

	// A missing timestamp still reads as an absent value rather than an epoch.
	expect(html).toContain('>—</span>')

	const timestampHtml = await renderToString(
		jsx(TimestampValue, { value: '2026-08-07 10:11:12' }),
	)
	expect(readRulesFor(timestampHtml, 'span')).toContain(
		'font-variant-numeric: tabular-nums',
	)

	const missing = await renderToString(
		jsx(TimestampValue, { value: null, fallback: 'Unknown' }),
	)
	expect(missing).toContain('>Unknown</span>')
})

test('account subnav lists secrets and memories and omits values', async () => {
	const html = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Overview',
			description: 'Account home',
			currentHref: '/account',
		}),
	)

	expect(html).toContain('aria-label="Account sections"')
	expect(html).toContain('href="/account/secrets"')
	expect(html).toContain('href="/account/memories"')
	expect(html).not.toContain('href="/account/values"')
	expect(html).not.toContain('>Values</a>')
})

test('inline link nav stays in flow and is not a second account rail', async () => {
	const items = [
		{ href: '/admin/community-reports', label: 'Open', active: true },
		{
			href: '/admin/community-reports?status=resolved',
			label: 'Resolved',
			active: false,
		},
	]

	const railHtml = await renderToString(
		jsx(AccountManagementLinkNav, {
			label: 'Admin sections',
			items,
		}),
	)
	expect(railHtml).toContain('data-account-nav')
	expect(readRulesFor(railHtml, 'nav')).toContain('position: absolute')

	const inlineHtml = await renderToString(
		jsx(AccountManagementInlineLinkNav, {
			label: 'Report status',
			items,
		}),
	)
	expect(inlineHtml).toContain('aria-label="Report status"')
	expect(inlineHtml).toContain('>Open</a>')
	expect(inlineHtml).not.toContain('data-account-nav')
	expect(readRulesFor(inlineHtml, 'nav')).not.toContain('position: absolute')
})

test('community reports page keeps one admin rail and an in-flow status filter', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: '/admin/community-reports',
			children: jsx(AppLoaderDataProvider, {
				children: jsx(AdminCommunityReportsRoute, {}),
			}),
		}),
	)

	// The shell CSS mentions `[data-account-nav]`; count the live attribute.
	expect((html.match(/(?<!\[)data-account-nav/g) ?? []).length).toBe(1)
	expect(html).toContain('aria-label="Admin sections"')
	expect(html).toContain('aria-label="Report status"')
	expect(html).toContain('href="/admin/community-reports?status=resolved"')
})
