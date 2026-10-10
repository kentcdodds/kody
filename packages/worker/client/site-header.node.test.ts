import { expect, test, vi } from 'vitest'
import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { dismissOpenPopoverPanel, SiteHeader } from './site-header.tsx'

test('dismissOpenPopoverPanel hides open popovers and no-ops when unavailable or closed', () => {
	const unavailableMatches = vi.fn(() => {
		throw new SyntaxError(
			"Failed to execute 'matches' on 'Element': ':popover-open' is not a valid selector.",
		)
	})
	const unavailablePanel = {
		matches: unavailableMatches,
	} as unknown as HTMLElement
	expect(() => dismissOpenPopoverPanel(unavailablePanel)).not.toThrow()
	expect(unavailableMatches).not.toHaveBeenCalled()

	const hidePopover = vi.fn()
	const openPanel = {
		hidePopover,
		matches: vi.fn((selector: string) => selector === ':popover-open'),
	} as unknown as HTMLElement
	dismissOpenPopoverPanel(openPanel)
	expect(openPanel.matches).toHaveBeenCalledWith(':popover-open')
	expect(hidePopover).toHaveBeenCalledOnce()

	const closedHidePopover = vi.fn()
	const closedPanel = {
		hidePopover: closedHidePopover,
		matches: vi.fn(() => false),
	} as unknown as HTMLElement
	dismissOpenPopoverPanel(closedPanel)
	expect(closedHidePopover).not.toHaveBeenCalled()
})

test('logged-in header has one menu: the organization, then your own links and Log out', async () => {
	const html = await renderToString(
		jsx(SiteHeader, {
			loggedIn: true,
			displayName: 'Ada Lovelace',
			username: 'ada',
			avatarUrl: '/profiles/ada/avatar/abc.jpg',
			showAdminLink: false,
			showDemoIndicator: false,
			loginHref: '/login',
			currentPathname: '/account',
		}),
	)

	// No separate Account link or profile avatar beside the switcher.
	expect(html).not.toContain('data-testid="site-header-account"')
	expect(html).not.toContain('data-testid="site-header-profile"')
	expect(html).not.toContain('data-testid="site-header-account-menu"')
	expect(html).toContain('aria-label="@ada: organizations and account"')
	// The photo is drawn once on the trigger and once on the signup org row
	// in each panel (desktop popover and phone menu), never as its own link.
	const trigger = html.slice(
		html.indexOf('data-testid="org-switcher"'),
		html.indexOf('data-testid="org-switcher-panel"'),
	)
	expect(trigger.match(/avatar\/abc\.jpg/g)).toHaveLength(1)
	expect(html).toContain('min-height: 44px')

	// A single organization is the person: their name and handle, no role,
	// and the mobile menu does not list the handle twice.
	const menu = html.slice(html.indexOf('data-testid="org-switcher-menu"'))
	expect(menu).toContain('>Ada Lovelace<')
	expect(menu).toContain('>@ada<')
	expect(menu).toContain('>Create organization<')
	// No invites waiting: the row stays out of the way.
	expect(menu).not.toContain('>Invites<')
	expect(html).not.toContain('Owner')
	expect(menu.match(/data-testid="org-switcher-ada"/g)).toHaveLength(1)

	const account = menu.slice(
		menu.indexOf('data-testid="org-switcher-account-group"'),
	)
	expect(account).toContain('>Your account<')
	expect(account).toMatch(/href="\/@ada"[^>]*>[\s\S]*?>Your profile</)
	expect(account).toMatch(
		/href="\/account"[^>]*aria-current="page"[^>]*>[\s\S]*?>Account settings</,
	)
	expect(account).toMatch(
		/<form[^>]*action="\/logout"[\s\S]*?data-testid="org-switcher-logout"[\s\S]*?>Log out</,
	)
})

test('org switcher lists the signup organization, then others with roles, then create and waiting invites', async () => {
	const html = await renderToString(
		jsx(SiteHeader, {
			loggedIn: true,
			displayName: 'Ada Lovelace',
			username: 'ada',
			avatarUrl: null,
			showAdminLink: false,
			showDemoIndicator: false,
			loginHref: '/login',
			currentPathname: '/@acme/-/secrets',
			organizations: [
				{
					slug: 'acme',
					displayName: 'Acme',
					role: 'member',
					personal: false,
				},
				{
					slug: 'ada',
					displayName: 'Ada',
					role: 'owner',
					personal: true,
				},
			],
			inviteCount: 2,
			lastUsedOrganization: 'ada',
		}),
	)
	const menu = html.slice(html.indexOf('data-testid="org-switcher-menu"'))
	const adaAt = menu.indexOf('>@ada · Owner<')
	const acmeAt = menu.indexOf('>@acme · Member<')
	const createAt = menu.indexOf('>Create organization<')
	const invitesAt = menu.indexOf('>Invites<')
	expect(adaAt).toBeGreaterThan(-1)
	expect(acmeAt).toBeGreaterThan(adaAt)
	expect(createAt).toBeGreaterThan(acmeAt)
	expect(invitesAt).toBeGreaterThan(createAt)
	expect(menu.slice(invitesAt)).toMatch(/^>Invites<\/span>[\s\S]*?>2</)
	expect(html).toContain('aria-label="@acme: organizations and account"')
	expect(menu).toContain('href="/account/organizations#invites"')
	// The org in the URL is current: checked and announced, the other is not.
	const acmeRow = menu.slice(
		menu.lastIndexOf('<a', menu.indexOf('data-testid="org-switcher-acme"')),
		menu.indexOf('>', menu.indexOf('data-testid="org-switcher-acme"')) + 1,
	)
	expect(acmeRow).toContain('aria-current="true"')
	expect(acmeRow).toContain('data-selected')
	const adaRow = menu.slice(
		menu.lastIndexOf('<a', menu.indexOf('data-testid="org-switcher-ada"')),
		menu.indexOf('>', menu.indexOf('data-testid="org-switcher-ada"')) + 1,
	)
	expect(adaRow).not.toContain('aria-current')
	expect(adaRow).not.toContain('data-selected')
	// Personal org keeps the section; non-personal lands on org home (#3073).
	expect(html).toContain('href="/@ada/-/secrets"')
	expect(html).toContain('href="/@acme"')
	expect(html).not.toContain('href="/@acme/-/secrets"')
	expect(html).toContain('data-icon="plus"')
	expect(html).toContain('data-icon="mail"')
})

test('logged-out header shows Log in without an Account link', async () => {
	const html = await renderToString(
		jsx(SiteHeader, {
			loggedIn: false,
			displayName: '',
			username: '',
			avatarUrl: null,
			showAdminLink: false,
			showDemoIndicator: false,
			loginHref: '/login',
			currentPathname: '/',
		}),
	)

	expect(html).toContain('href="/login"')
	expect(html).toContain('>Log in</a>')
	expect(html).not.toContain('data-testid="site-header-account"')
	expect(html).not.toContain('data-testid="site-header-account-menu"')
})
