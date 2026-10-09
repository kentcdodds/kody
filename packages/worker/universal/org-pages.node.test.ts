import { expect, test } from 'vitest'
import {
	accountAliasPath,
	accountResourceRedirectPath,
	currentSwitcherSlug,
	orderOrganizations,
	orgRoleLabel,
	orgSwitcherEntries,
	parseOrgResourcePath,
	switchOrgPath,
	type OrganizationSummary,
} from './org-pages.ts'

const personal: OrganizationSummary = {
	slug: 'ada',
	displayName: 'Ada',
	role: 'owner',
	personal: true,
}
const acme: OrganizationSummary = {
	slug: 'acme',
	displayName: 'Acme',
	role: 'member',
	personal: false,
}
const billing: OrganizationSummary = {
	slug: 'billing-co',
	displayName: null,
	role: 'billing',
	personal: false,
}

test('account resource redirects map pages onto the signup organization', () => {
	expect(accountResourceRedirectPath('/account/packages', 'ada')).toBe(
		'/@ada/packages',
	)
	expect(accountResourceRedirectPath('/account/secrets', 'ada')).toBe(
		'/@ada/secrets',
	)
	expect(accountResourceRedirectPath('/account/secrets/new', 'ada')).toBe(
		'/@ada/secrets/new',
	)
	expect(accountResourceRedirectPath('/account/jobs/job-1', 'ada')).toBe(
		'/@ada/jobs/job-1',
	)
	expect(accountResourceRedirectPath('/account/packages/pkg-1', 'ada')).toBe(
		null,
	)
	expect(accountResourceRedirectPath('/account/secrets.json', 'ada')).toBe(null)
	expect(accountResourceRedirectPath('/account/passkeys', 'ada')).toBe(null)
	expect(accountResourceRedirectPath('/account/billing', 'ada')).toBe(null)
	expect(accountResourceRedirectPath('/account', 'ada')).toBe(null)
	expect(accountResourceRedirectPath('/account/experiments', 'ada')).toBe(null)
})

test('org resource paths alias back to account loaders and ignore package apps', () => {
	expect(parseOrgResourcePath('/@acme/secrets/user/token')).toEqual({
		slug: 'acme',
		section: 'secrets',
		rest: 'user/token',
	})
	expect(accountAliasPath('/@acme/secrets/user/token')).toBe(
		'/account/secrets/user/token',
	)
	expect(parseOrgResourcePath('/@acme/packages/devin')).toBeNull()
	expect(parseOrgResourcePath('/@acme/webhooks/devin/hook/secret')).toBeNull()
	expect(parseOrgResourcePath('/@acme/packages')).toEqual({
		slug: 'acme',
		section: 'packages',
		rest: '',
	})
})

test('switching keeps the same kind of page or falls back to organization home', () => {
	expect(switchOrgPath('/@acme/secrets', 'other')).toBe('/@other/secrets')
	expect(switchOrgPath('/@acme/secrets/new', 'other')).toBe(
		'/@other/secrets/new',
	)
	expect(switchOrgPath('/@acme/devin', 'other')).toBe('/@other')
	expect(switchOrgPath('/account', 'other')).toBe('/@other')
	expect(switchOrgPath('/pricing', 'other')).toBe('/@other')
})

test('switcher lists the signup organization first, then roles, then create and invites', () => {
	expect(
		orderOrganizations([acme, billing, personal]).map((org) => org.slug),
	).toEqual(['ada', 'acme', 'billing-co'])

	const multiple = orgSwitcherEntries([acme, personal], 2)
	expect(multiple).toEqual([
		{ kind: 'org', org: personal, showRole: true },
		{ kind: 'org', org: acme, showRole: true },
		{ kind: 'create' },
		{ kind: 'invites', count: 2 },
	])

	const single = orgSwitcherEntries([personal], 0)
	expect(single.map((entry) => entry.kind)).toEqual([
		'org',
		'create',
		'invites',
	])
	expect(single[0]).toEqual({ kind: 'org', org: personal, showRole: false })
	expect(orgRoleLabel('owner')).toBe('Owner')
	expect(orgRoleLabel(null)).toBe('Collaborator')
})

test('current organization comes from the URL, then the last-used slug', () => {
	const organizations = [personal, acme]
	expect(
		currentSwitcherSlug({
			pathname: '/@acme/secrets',
			organizations,
			lastUsedSlug: 'ada',
		}),
	).toBe('acme')
	expect(
		currentSwitcherSlug({
			pathname: '/account',
			organizations,
			lastUsedSlug: 'acme',
		}),
	).toBe('acme')
	expect(
		currentSwitcherSlug({
			pathname: '/account',
			organizations,
			lastUsedSlug: null,
		}),
	).toBe('ada')
})
