import { expect, test } from 'vitest'
import { fetchSessionInfo } from './session.ts'

test('fetchSessionInfo keeps organization photos the chooser draws', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input) => {
		expect(String(input)).toContain('/session')
		return new Response(
			JSON.stringify({
				ok: true,
				session: {
					email: 'ada@example.com',
					username: 'ada',
					avatarUrl: ' /profiles/ada/avatar/person.png ',
					organizations: [
						{
							slug: 'ada',
							displayName: 'Ada',
							role: 'owner',
							personal: true,
							avatarUrl: null,
						},
						{
							slug: 'acme',
							displayName: 'Acme',
							role: 'owner',
							personal: false,
							avatarUrl: ' /orgs/acme/avatar/hash.png ',
						},
						{
							slug: 'blank',
							displayName: null,
							role: 'member',
							personal: false,
							avatarUrl: '   ',
						},
						{
							slug: ' ',
							displayName: 'Skipped',
							role: 'owner',
							personal: false,
							avatarUrl: '/orgs/skipped/avatar/x.png',
						},
					],
				},
			}),
		)
	}
	try {
		const session = await fetchSessionInfo()
		expect(session?.avatarUrl).toBe('/profiles/ada/avatar/person.png')
		expect(session?.organizations).toEqual([
			{
				slug: 'ada',
				displayName: 'Ada',
				role: 'owner',
				personal: true,
				avatarUrl: null,
			},
			{
				slug: 'acme',
				displayName: 'Acme',
				role: 'owner',
				personal: false,
				avatarUrl: '/orgs/acme/avatar/hash.png',
			},
			{
				slug: 'blank',
				displayName: null,
				role: 'member',
				personal: false,
				avatarUrl: null,
			},
		])
	} finally {
		globalThis.fetch = originalFetch
	}
})
