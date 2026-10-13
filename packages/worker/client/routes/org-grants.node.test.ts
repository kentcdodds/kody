import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { OrgGrantsRoute } from '#client/routes/org-grants.tsx'
import { type SessionInfo } from '#client/session.ts'
import { type OrgGrantsLoaderData } from '#universal/loader-data.ts'

const session: SessionInfo = {
	email: 'bob@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'bob',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
	organizations: [
		{
			slug: 'zeta-co',
			displayName: 'Zeta Co',
			role: 'member',
			personal: false,
		},
	],
}

function grant(
	id: string,
	canRevoke: boolean,
): OrgGrantsLoaderData['grants'][number] {
	return {
		id,
		resourceType: 'package',
		resourceId: 'pkg-1',
		resourceLabel: 'Demo Package',
		subjectType: 'user',
		subjectId: id,
		subjectLabel: `@${id}`,
		preset: 'use',
		presetLabel: 'Use',
		permissions: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		canRevoke,
	}
}

function renderGrants(orgGrants: OrgGrantsLoaderData) {
	return renderToString(
		jsx(RouterLocationProvider, {
			url: '/@zeta-co/-/grants',
			children: jsx(AppSessionProvider, {
				session,
				status: 'ready',
				children: jsx(AppLoaderDataProvider, {
					loaderData: { orgGrants },
					children: jsx(OrgGrantsRoute, {}),
				}),
			}),
		}),
	)
}

const org: OrgGrantsLoaderData['org'] = {
	id: 'org-zeta',
	slug: 'zeta-co',
	displayName: 'Zeta Co',
	avatarUrl: null,
	personal: false,
	role: 'member',
}

function row(html: string, grantId: string) {
	const marker = `data-grant-id="${grantId}"`
	const start = html.indexOf(marker)
	expect(start).toBeGreaterThan(-1)
	const next = html.indexOf('data-grant-id=', start + marker.length)
	return html.slice(start, next === -1 ? undefined : next)
}

test('revoke is offered only for grants the viewer may revoke', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: true,
		grants: [grant('grant-ok', true), grant('grant-denied', false)],
	})

	expect(row(html, 'grant-ok')).toContain('data-testid="org-grant-revoke"')
	expect(row(html, 'grant-ok')).toContain('>Revoke<')
	expect(row(html, 'grant-denied')).not.toContain('org-grant-revoke')
	expect(row(html, 'grant-denied')).not.toContain('>Revoke<')
})

test('member:write alone does not show revoke buttons', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: true,
		grants: [grant('grant-denied', false)],
	})
	expect(html).toContain('data-testid="org-grants"')
	expect(html).not.toContain('data-testid="org-grant-revoke"')
	expect(html).not.toContain('>Revoke<')
})

test('a viewer who cannot manage members sees no revoke buttons', async () => {
	const html = await renderGrants({
		ok: true,
		org,
		canManage: false,
		grants: [grant('grant-resource-ok', true)],
	})
	expect(html).toContain('data-grant-id="grant-resource-ok"')
	expect(html).not.toContain('data-testid="org-grant-revoke"')
})
