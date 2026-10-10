import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AdminCommunityReportsRoute } from '#client/routes/admin-community-reports.tsx'
import {
	AccountManagementInlineLinkNav,
	AccountManagementLinkNav,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import { type SessionInfo } from '#client/session.ts'
import { routes } from '#universal/routes.ts'

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

test('inline link nav stays in flow and is not a second account rail', async () => {
	const items = [
		{
			href: '/admin/community-reports',
			label: 'Open',
			active: true,
			icon: 'warning-triangle' as const,
		},
		{
			href: '/admin/community-reports?status=resolved',
			label: 'Resolved',
			active: false,
			icon: 'check' as const,
		},
	]

	const railHtml = await renderToString(
		jsx(AccountManagementLinkNav, {
			label: 'Admin sections',
			groups: [{ label: null, items }],
		}),
	)
	expect(railHtml).toContain('data-account-nav')
	const railRules = readRulesFor(railHtml, 'nav')
	// The rail is the shell's left track: as tall as the shell (which grows
	// down to the footer on a short page), clipped so it cannot paint over
	// the footer. The link column inside sticks and scrolls.
	expect(railRules).toContain('position: absolute')
	expect(railRules).toContain('bottom: 0')
	expect(railRules).toContain('overflow: clip')
	expect(railHtml).toContain('position: sticky')
	expect(railHtml).toContain('<details')
	expect(railHtml).toContain('>Admin sections</span>')
	expect(railHtml).toContain('data-icon="menu"')
	expect(railHtml).toContain('data-icon="warning-triangle"')
	expect(railHtml).toContain('>Open</span>')
	expect(railHtml).toContain('>Open</a>')
	expect(railHtml).toContain('min-height: 44px')
	expect(railHtml).toContain('@media (max-width: 860px)')

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

test('grouped rail names its groups and whose settings they are', async () => {
	const html = await renderToString(
		jsx(AccountManagementLinkNav, {
			label: 'Workspace sections',
			heading: { eyebrow: 'Workspace', name: '@jane' },
			groups: [
				{
					label: 'Build',
					items: [
						{ href: '/@jane/-/packages', label: 'Repositories', active: true },
					],
				},
				{
					label: 'Data',
					items: [
						{ href: '/@jane/-/secrets', label: 'Secrets', active: false },
					],
				},
			],
		}),
	)
	expect(html).toContain('>Workspace</span>')
	expect(html).toContain('>@jane</span>')
	expect(html).toContain('role="group" aria-label="Build"')
	expect(html).toContain('role="group" aria-label="Data"')
	// The phone summary names the workspace and the current section.
	expect(html).toMatch(/<summary>[\s\S]*?>@jane<\/span>[\s\S]*?>Repositories</)
})

test('account shell grows into main so a short page has no band above the footer', async () => {
	const shellHtml = await renderToString(
		jsx(AccountManagementShell, { children: jsx('p', { children: 'Short' }) }),
	)
	const shellRules = readRulesFor(shellHtml, 'section')
	expect(shellRules).toContain('flex-grow: 1')
	expect(shellRules).toContain('width: 100%')
	expect(shellRules).toContain('align-content: start')
	// With a rail, the shell is at least as tall as the rail's measured link
	// column, so a short page never hides links behind an inner scroll.
	expect(shellHtml).toContain(
		'min-height: calc(var(--account-rail-height, 0px)',
	)

	// `<main>` keeps growing in the 100vh app frame (sticky footer) and hands
	// that growth to the shell through a flex column.
	const styles = readFileSync(
		fileURLToPath(new URL('../../public/styles.css', import.meta.url)),
		'utf8',
	)
	const mainRule = /main:has\(\[data-account-shell\]\) \{([^}]*)\}/.exec(
		styles,
	)?.[1]
	expect(mainRule).toContain('display: flex')
	expect(mainRule).toContain('flex-direction: column')
	expect(mainRule).not.toContain('flex-grow')
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

test('team settings rail names the URL org when the session list is personal-only', async () => {
	const session: SessionInfo = {
		email: 'ada@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		username: 'ada',
		avatarUrl: null,
		roles: [],
		permissions: [],
		featureFlags: {} as SessionInfo['featureFlags'],
		organizations: [
			{
				slug: 'ada',
				displayName: 'Ada',
				role: 'owner',
				personal: true,
			},
		],
		lastUsedOrganization: 'ada',
	}
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: '/@acme/-/settings',
			children: jsx(AppSessionProvider, {
				session,
				status: 'ready',
				children: jsx(AccountPageHeader, {
					title: 'Settings',
					description: 'Organization settings.',
					currentHref: '/@acme/-/settings',
				}),
			}),
		}),
	)
	// Heading and Organization rail follow the URL org (member-shaped when
	// the session list omitted the team — no Billing).
	expect(html).toContain('>@acme<')
	expect(html).toContain('href="/@acme/-/settings"')
	expect(html).toContain('href="/@acme/-/members"')
	expect(html).toContain('aria-label="Organization"')
	expect(html).not.toContain('href="/@acme/-/billing"')
	expect(html).toContain('href="/@acme/-/jobs"')
	expect(html).toContain('href="/@acme/-/secrets"')
	// No personal workspace links leak onto the team URL.
	expect(html).not.toContain('href="/@ada/-/')
	expect(html).not.toContain('href="/@acme/-/packages"')
	expect(html).not.toContain('href="/@acme/-/connections"')
})

test('account page header puts the phone section menu above the heading', async () => {
	const connectionsHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Connections',
			description:
				'The agents connected to this Kody account, and how to connect another.',
			currentHref: '/account/connections',
		}),
	)
	const menu = connectionsHtml.indexOf('>Workspace</span>')
	const heading = connectionsHtml.indexOf('<h1')
	const trigger = connectionsHtml.indexOf(
		'data-entity-explainer-trigger="connections"',
	)
	const description = connectionsHtml.indexOf('The agents connected')
	expect(menu).toBeGreaterThan(-1)
	expect(heading).toBeGreaterThan(menu)
	expect(trigger).toBeGreaterThan(heading)
	expect(description).toBeGreaterThan(trigger)
	expect(connectionsHtml).toContain('data-icon="information"')
	expect(connectionsHtml).toContain('data-account-nav')

	const billingHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Billing',
			description: 'Plan and invoices.',
			currentHref: '/account/billing',
		}),
	)
	expect(billingHtml.indexOf('<h1')).toBeGreaterThan(
		billingHtml.indexOf('>Workspace</span>'),
	)
	expect(billingHtml).toContain('aria-label="Workspace sections"')
	expect(billingHtml).not.toContain('data-entity-explainer')
})
