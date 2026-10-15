import { expect, test } from 'vitest'
import {
	isPackageCollaboratorPreset,
	packageCollaboratorInvitePresetExplanation,
	packageCollaboratorInviteeLabel,
	packageCollaboratorsHref,
	readPackageCollaboratorInvitee,
	readPackageCollaboratorsPath,
} from './package-collaborators.ts'

test('reads the package collaborators path and rejects org pages', () => {
	expect(
		readPackageCollaboratorsPath('/@acme/release-notes/collaborators'),
	).toEqual({
		username: 'acme',
		kodyId: 'release-notes',
	})
	expect(
		readPackageCollaboratorsPath('/@acme/release-notes/collaborators/'),
	).toEqual({
		username: 'acme',
		kodyId: 'release-notes',
	})
	expect(readPackageCollaboratorsPath('/@acme/-/collaborators')).toBeNull()
	expect(
		readPackageCollaboratorsPath('/@acme/release-notes/settings'),
	).toBeNull()
	expect(
		readPackageCollaboratorsPath('/@acme/%E0%A4%A/collaborators'),
	).toBeNull()
	expect(
		packageCollaboratorsHref({ username: 'acme', kodyId: 'release-notes' }),
	).toBe('/@acme/release-notes/collaborators')
})

test('accepts only the shared grant presets', () => {
	expect(
		['use', 'contribute', 'manage'].every(isPackageCollaboratorPreset),
	).toBe(true)
	expect(isPackageCollaboratorPreset('owner')).toBe(false)
	expect(isPackageCollaboratorPreset(null)).toBe(false)
})

test('reads an invitee as an email or a username with or without @', () => {
	expect(readPackageCollaboratorInvitee(' jesse@example.com ')).toEqual({
		email: 'jesse@example.com',
	})
	expect(readPackageCollaboratorInvitee('@jesse')).toEqual({
		username: 'jesse',
	})
	expect(readPackageCollaboratorInvitee('jesse')).toEqual({
		username: 'jesse',
	})
	expect(
		packageCollaboratorInviteeLabel({
			inviteeEmail: null,
			inviteeUsername: 'jesse',
		}),
	).toBe('@jesse')
	expect(
		packageCollaboratorInviteeLabel({
			inviteeEmail: 'jesse@example.com',
			inviteeUsername: null,
		}),
	).toBe('jesse@example.com')
})

test('explains that only Contribute and Manage can update the package', () => {
	expect(packageCollaboratorInvitePresetExplanation('use')).toMatch(
		/cannot change it/,
	)
	for (const preset of ['contribute', 'manage'] as const) {
		expect(packageCollaboratorInvitePresetExplanation(preset)).toMatch(
			/update it from their own Kody/,
		)
	}
})
