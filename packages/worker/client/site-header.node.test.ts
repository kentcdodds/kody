import { expect, test, vi } from 'vitest'
import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import {
	accountMenuManageLinks,
	SiteHeader,
	usageHrefForAccountMenu,
} from './site-header.tsx'
import { dismissOpenPopoverPanel } from './switcher-menu.tsx'

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

	// Safari 16: hidePopover may exist while matches(':popover-open') throws.
	const throwingHide = vi.fn()
	const throwingMatches = vi.fn(() => {
		throw new SyntaxError('The string did not match the expected pattern.')
	})
	const throwingPanel = {
		hidePopover: throwingHide,
		matches: throwingMatches,
	} as unknown as HTMLElement
	expect(() => dismissOpenPopoverPanel(throwingPanel)).not.toThrow()
	expect(throwingMatches).toHaveBeenCalledWith(':popover-open')
	expect(throwingHide).not.toHaveBeenCalled()
})

test('logged-in header has only the account menu; the org switcher lives in the workspace rail', async () => {
	const html = await renderToString(
		jsx(SiteHeader, {
			loggedIn: true,
			displayName: 'Ada Lovelace',
			username: 'ada',
			avatarUrl: '/profiles/ada/avatar/abc.jpg',
			showAdminLink: false,
			showDemoIndicator: false,
			loginHref: '/login',
			currentPathname: '/@acme/-/secrets',
			organizations: [
				{ slug: 'ada', displayName: 'Ada', role: 'owner', personal: true },
				{ slug: 'acme', displayName: 'Acme', role: 'member', personal: false },
			],
		}),
	)

	expect(html).not.toContain('switch organization')
	expect(html).not.toContain('data-testid="org-switcher"')
	expect(html).not.toContain('data-testid="org-switcher-panel"')
	expect(html).not.toContain('>Create organization<')
	expect(html).toContain('aria-label="Ada Lovelace: your account"')
	// The avatar is the only session control in the header.
	expect(html.match(/avatar\/abc\.jpg/g)).toHaveLength(1)
	const accountPanel = html.slice(
		html.indexOf('data-testid="account-menu-panel"'),
		html.indexOf('data-testid="site-menu-account"'),
	)
	expect(accountPanel).toContain('>@ada<')
	expect(accountPanel).not.toContain('>Your account<')
	expect(accountPanel).toMatch(/href="\/@ada"[^>]*>[\s\S]*?>Your profile</)
	expect(accountPanel).toMatch(
		/href="\/account"[^>]*>[\s\S]*?>Account settings</,
	)
	expect(accountPanel).toContain('action="/logout"')

	// The phone menu folds the avatar menu in: Manage reaches every
	// workspace, then the person's own links.
	const menu = html.slice(html.indexOf('data-testid="site-menu-account"'))
	expect(menu).not.toContain('switch organization')
	const manage = menu.slice(
		menu.indexOf('data-testid="account-menu-manage-group"'),
		menu.indexOf('data-testid="org-switcher-account-group"'),
	)
	expect(manage).toMatch(/href="\/@acme"[^>]*>[\s\S]*?>Overview</)
	expect(manage).toMatch(/href="\/@ada\/-\/overview"[^>]*>[\s\S]*?>@ada</)
	const account = menu.slice(
		menu.indexOf('data-testid="org-switcher-account-group"'),
	)
	expect(account).toContain('>Your account<')
	expect(account).toMatch(/href="\/@ada"[^>]*>[\s\S]*?>Your profile</)
	expect(account).toContain('>Usage &amp; credits<')
	expect(account).toMatch(
		/<form[^>]*action="\/logout"[\s\S]*?data-testid="org-switcher-logout"[\s\S]*?>Log out</,
	)
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

test('account menu Usage & credits uses the URL org when billing is allowed', () => {
	const orgs = [
		{ slug: 'ada', personal: true, role: 'owner' as const },
		{ slug: 'acme', personal: false, role: 'owner' as const },
	]
	expect(
		usageHrefForAccountMenu({
			pathname: '/@acme/-/billing',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@acme/-/usage')
	expect(
		usageHrefForAccountMenu({
			pathname: '/account',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@ada/-/usage')
	expect(
		usageHrefForAccountMenu({
			pathname: '/@acme',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@acme/-/usage')
	expect(
		usageHrefForAccountMenu({
			pathname: '/@stranger/pkg',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@ada/-/usage')
})

test('account menu Usage & credits falls back when the URL org lacks billing', () => {
	const orgs = [
		{ slug: 'ada', personal: true, role: 'owner' as const },
		{ slug: 'acme', personal: false, role: 'member' as const },
	]
	expect(
		usageHrefForAccountMenu({
			pathname: '/@acme/-/agents',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@ada/-/usage')
	expect(
		usageHrefForAccountMenu({
			pathname: '/@acme',
			organizations: orgs,
			username: 'ada',
		}),
	).toBe('/@ada/-/usage')
})

test('account menu Manage leads with the current workspace Overview, then every other workspace', () => {
	const organizations = [
		{
			slug: 'kody',
			displayName: 'Kody',
			role: 'owner' as const,
			personal: false,
		},
		{
			slug: 'kentcdodds',
			displayName: 'Kent',
			role: 'owner' as const,
			personal: true,
		},
		{ slug: 'acme', displayName: 'Acme', role: null, personal: false },
	]
	const links = (pathname: string, lastUsedSlug: string | null = null) =>
		accountMenuManageLinks({
			pathname,
			organizations,
			lastUsedSlug,
		}).map((link) => [link.label, link.href, link.detail])
	// The org in the URL is the one Manage opens first.
	expect(links('/@kody/-/credentials')).toEqual([
		['Overview', '/@kody', '@kody'],
		['@kentcdodds', '/@kentcdodds/-/overview', null],
		['@acme', '/@acme', null],
	])
	// Off an org page, the switcher's org (last used) leads.
	expect(links('/account', 'kody')).toEqual(links('/@kody'))
	expect(links('/account')).toEqual([
		['Overview', '/@kentcdodds/-/overview', '@kentcdodds'],
		['@acme', '/@acme', null],
		['@kody', '/@kody', null],
	])
	// A stale session list leaves the URL org's kind unknown (a renamed
	// person's signup org keeps its old slug), so Overview takes the path
	// that serves the signup org and redirects a team to its home.
	expect(
		accountMenuManageLinks({
			pathname: '/@kent-old/-/overview',
			organizations: [],
			lastUsedSlug: null,
		}).map((link) => [link.label, link.href, link.detail]),
	).toEqual([['Overview', '/@kent-old/-/overview', '@kent-old']])
})

test('account menu shows a Manage section before the person links; the phone menu keeps Overview', async () => {
	const html = await renderToString(
		jsx(SiteHeader, {
			loggedIn: true,
			displayName: 'kentcdodds',
			username: 'kentcdodds',
			avatarUrl: null,
			showAdminLink: false,
			showDemoIndicator: false,
			loginHref: '/login',
			currentPathname: '/@kody',
			organizations: [
				{ slug: 'kody', displayName: 'Kody', role: 'owner', personal: false },
				{
					slug: 'kentcdodds',
					displayName: null,
					role: 'owner',
					personal: true,
				},
			],
			lastUsedOrganization: 'kody',
		}),
	)
	const accountPanel = html.slice(
		html.indexOf('data-testid="account-menu-panel"'),
		html.indexOf('data-testid="org-switcher-menu"'),
	)
	const manage = accountPanel.slice(
		accountPanel.lastIndexOf(
			'<div',
			accountPanel.indexOf('data-testid="account-menu-manage-group"'),
		),
		accountPanel.indexOf('data-testid="org-switcher-account-group"'),
	)
	expect(manage).toContain('aria-label="Manage"')
	expect(manage).toContain('>Manage<')
	expect(manage).toMatch(
		/href="\/@kody"[^>]*aria-current="page"[^>]*>[\s\S]*?>Overview<[\s\S]*?>@kody</,
	)
	expect(manage).toMatch(
		/href="\/@kentcdodds\/-\/overview"[^>]*>[\s\S]*?>@kentcdodds</,
	)
	expect(manage.indexOf('>Overview<')).toBeLessThan(
		manage.indexOf('>@kentcdodds<'),
	)
	expect(accountPanel.indexOf('account-menu-manage-group')).toBeLessThan(
		accountPanel.indexOf('>Your profile<'),
	)

	const menu = html.slice(html.indexOf('data-testid="site-menu-account"'))
	const phoneManage = menu.slice(
		menu.indexOf('data-testid="account-menu-manage-group"'),
		menu.indexOf('data-testid="org-switcher-account-group"'),
	)
	expect(phoneManage).toMatch(/href="\/@kody"[^>]*>[\s\S]*?>Overview</)
	// No org switcher in the header, so the phone Manage group lists every
	// other workspace too.
	expect(phoneManage).toContain('data-testid="org-switcher-manage-kentcdodds"')
})
