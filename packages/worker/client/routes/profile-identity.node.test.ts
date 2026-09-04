import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderProfileIdentity } from './profile-identity.tsx'
import { type ProfileShellLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'

const publicSelf = {
	ok: true,
	username: 'jane',
	displayName: 'Jane Example',
	bio: 'Builds packages for other people to take.',
	avatarUrl: '/profiles/jane/avatar/hash.png',
	joinedAt: '2026-03-01T00:00:00.000Z',
	isSelf: true,
	loggedIn: true,
	visibility: 'public',
} satisfies ProfileShellLoaderData

test('profile identity renders the person in HTML and keeps guest CTAs honest', async () => {
	const ownHtml = await renderToString(renderProfileIdentity(publicSelf))
	expect(ownHtml).toContain('data-testid="profile-identity"')
	expect(ownHtml).toContain('data-testid="profile-display-name"')
	expect(ownHtml).toContain('Jane Example')
	expect(ownHtml).toContain('@jane')
	expect(ownHtml).toContain('Builds packages for other people to take.')
	expect(ownHtml).toContain('src="/profiles/jane/avatar/hash.png"')
	expect(ownHtml).toContain('width: 72px')
	expect(ownHtml).toContain('@media (min-width: 821px)')
	expect(ownHtml).toContain('width: 160px')
	expect(ownHtml).toContain('Joined March 1, 2026')
	expect(ownHtml).toContain('Edit profile')
	expect(ownHtml).toContain(`href="${routes.account.href()}"`)
	expect(ownHtml).toContain('This is how the world sees you.')
	expect(ownHtml).toContain('data-entity-explainer="profile"')
	expect(ownHtml).not.toContain('Connect your agent')
	expect(ownHtml).not.toContain('data-testid="profile-guest-cta"')
	expect(ownHtml).not.toContain('data-testid="profile-private-badge"')
	expect(ownHtml).not.toContain('href="/account/waiting"')
	expect(ownHtml).not.toContain('Log out')

	const privateHtml = await renderToString(
		renderProfileIdentity({
			...publicSelf,
			visibility: 'private',
		}),
	)
	expect(privateHtml).toContain('data-testid="profile-private-badge"')
	expect(privateHtml).toContain('Private')

	const guestHtml = await renderToString(
		renderProfileIdentity({
			...publicSelf,
			isSelf: false,
			loggedIn: false,
		}),
	)
	expect(guestHtml).toContain('data-testid="profile-guest-cta"')
	expect(guestHtml).toContain('Log in or sign up to fork these packages.')
	expect(guestHtml).toContain('Log in')
	expect(guestHtml).toContain('Sign up')
	expect(guestHtml).toContain(
		`href="${routes.login.href()}?redirectTo=${encodeURIComponent('/@jane')}"`,
	)
	expect(guestHtml).toContain(
		`href="${routes.signup.href()}?redirectTo=${encodeURIComponent('/@jane')}"`,
	)
	expect(guestHtml).not.toContain('Connect your agent')
	expect(guestHtml).not.toContain('Edit profile')
	expect(guestHtml).not.toContain('data-testid="profile-actions"')

	const visitorHtml = await renderToString(
		renderProfileIdentity({
			...publicSelf,
			isSelf: false,
			loggedIn: true,
		}),
	)
	expect(visitorHtml).not.toContain('data-testid="profile-guest-cta"')
	expect(visitorHtml).not.toContain('Edit profile')
	expect(visitorHtml).toContain('Jane Example')
})
