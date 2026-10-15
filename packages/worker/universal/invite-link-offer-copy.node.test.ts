import { expect, test } from 'vitest'
import { inviteLinkOfferCopy } from '#universal/invite-link-offer-copy.ts'
import { type OrgInviteJoinLoaderData } from '#universal/loader-data.ts'

type JoinPageData = Extract<OrgInviteJoinLoaderData, { ok: true }>

function page(overrides: Partial<JoinPageData>): JoinPageData {
	return {
		ok: true,
		token: 'token',
		org: {
			slug: 'acme',
			displayName: 'Acme',
			avatarUrl: null,
			personal: false,
		},
		offer: { kind: 'membership', role: 'member', roleLabel: 'Member' },
		invitedBy: 'Ada',
		expiresAt: '2026-02-01T00:00:00.000Z',
		alreadyMember: false,
		authenticated: true,
		...overrides,
	}
}

test('membership links keep the join wording', () => {
	expect(inviteLinkOfferCopy(page({ invitedBy: null }))).toMatchObject({
		title: 'Join Acme',
		description: 'You are invited to join Acme as Member.',
		acceptLabel: 'Join Acme',
		openHref: '/@acme',
		notice: null,
	})
})

test('team links say that accepting also joins the org', () => {
	const copy = inviteLinkOfferCopy(
		page({ offer: { kind: 'team', teamName: 'Design', joinsOrg: true } }),
	)
	expect(copy).toMatchObject({
		title: 'Join the Design team',
		description: 'Ada invited you to join the Design team in Acme.',
		acceptLabel: 'Join the Design team',
		openHref: '/@acme/-/teams',
	})
	expect(copy.notice).toContain('also makes you a Member of Acme')
})

test('package links name the access and the outside collaborator outcome', () => {
	const copy = inviteLinkOfferCopy(
		page({
			offer: {
				kind: 'resource',
				packageName: 'Weather',
				packageHref: '/@acme/weather',
				preset: 'use',
				presetLabel: 'Use',
				presetDescription: 'Read the source and run it',
				outsideCollaborator: true,
			},
		}),
	)
	expect(copy).toMatchObject({
		title: 'Collaborate on Weather',
		description: 'Ada invited you to Weather with Use access.',
		subjectDetail: 'Use: Read the source and run it',
		acceptLabel: 'Accept Use access',
		openHref: '/@acme/weather',
	})
	expect(copy.notice).toContain('outside collaborator')
	expect(copy.notice).toContain('not membership in Acme')
})
