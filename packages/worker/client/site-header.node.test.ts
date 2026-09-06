import { expect, test, vi } from 'vitest'
import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
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

test('logged-in header shows Account to the left of the profile avatar', async () => {
	const html = await renderToString(
		jsx(SiteHeader, {
			loggedIn: true,
			displayName: 'Ada Lovelace',
			username: 'ada',
			avatarUrl: null,
			showAdminLink: false,
			showDemoIndicator: false,
			loginHref: '/login',
			currentPathname: '/account',
		}),
	)

	expect(html).toContain('href="/@ada"')
	expect(html).toContain('aria-label="@ada"')
	expect(html).toContain('data-testid="site-header-profile"')
	expect(html).toContain('data-testid="site-header-profile-menu"')
	expect(html).toMatch(/site-header-profile-menu[\s\S]*?>ada</)

	const accountTestIdAt = html.indexOf('data-testid="site-header-account"')
	const profileTestIdAt = html.indexOf('data-testid="site-header-profile"')
	expect(accountTestIdAt).toBeGreaterThan(-1)
	expect(profileTestIdAt).toBeGreaterThan(accountTestIdAt)
	const desktopAccountTag = html.slice(
		html.lastIndexOf('<a', accountTestIdAt),
		html.indexOf('>', accountTestIdAt) + 1,
	)
	expect(desktopAccountTag).toContain('href="/account"')
	expect(desktopAccountTag).toContain('aria-current="page"')
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
