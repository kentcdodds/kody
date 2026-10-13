import { expect, test } from 'vitest'
import {
	credentialNeedKeyNotes,
	mergeCredentialNeeds,
	ownCredentialNeeds,
	readStoredCredentialNeeds,
} from './credential-needs.ts'

test('own needs default provider to the key and sort by key', () => {
	expect(
		ownCredentialNeeds({
			google: { kind: 'oauth', multiple: true, description: 'Calendars.' },
			github_bot: {
				kind: 'oauth',
				provider: 'github',
				description: 'Bot account.',
			},
			github: { description: 'Read PRs to summarize them.' },
		}),
	).toEqual([
		{
			key: 'github',
			provider: 'github',
			description: 'Read PRs to summarize them.',
			multiple: false,
		},
		{
			key: 'github_bot',
			kind: 'oauth',
			provider: 'github',
			description: 'Bot account.',
			multiple: false,
		},
		{
			key: 'google',
			kind: 'oauth',
			provider: 'google',
			description: 'Calendars.',
			multiple: true,
		},
	])
	expect(ownCredentialNeeds(undefined)).toEqual([])
})

test('the closure tags inherited needs with the declaring package and refuses kind or provider conflicts', () => {
	const own = ownCredentialNeeds({
		github: { kind: 'oauth', description: 'Repos.' },
	})
	const merged = mergeCredentialNeeds({
		own,
		dependencies: [
			{
				packageName: '@acme/triage',
				needs: [
					{
						key: 'github',
						kind: 'oauth',
						provider: 'github',
						description: 'Issues.',
						multiple: true,
					},
					{
						key: 'linear',
						kind: 'mcp',
						provider: 'linear',
						description: 'Linear.',
						multiple: false,
						from: '@acme/linear-tools',
					},
				],
			},
			{
				packageName: '@acme/notify',
				needs: [
					{
						key: 'resend',
						kind: 'secret',
						provider: 'resend',
						description: 'Email.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(merged.conflicts).toEqual([])
	expect(merged.needs).toEqual([
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'Repos.',
			multiple: true,
		},
		{
			key: 'linear',
			kind: 'mcp',
			provider: 'linear',
			description: 'Linear.',
			multiple: false,
			from: '@acme/linear-tools',
		},
		{
			key: 'resend',
			kind: 'secret',
			provider: 'resend',
			description: 'Email.',
			multiple: false,
			from: '@acme/notify',
		},
	])

	const conflict = mergeCredentialNeeds({
		own,
		dependencies: [
			{
				packageName: '@acme/other',
				needs: [
					{
						key: 'github',
						kind: 'secret',
						provider: 'github',
						description: 'PAT.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(conflict.conflicts).toEqual([
		'kody.credentials.github: oauth from provider "github" (declared by this package) conflicts with secret from provider "github" (declared by @acme/other). Give one of them a different key.',
	])
})

test('omitted kind merges with a fetch-capable declared kind and keeps the declared kind', () => {
	const merged = mergeCredentialNeeds({
		own: ownCredentialNeeds({
			github: { description: 'Read PRs.' },
		}),
		dependencies: [
			{
				packageName: '@acme/triage',
				needs: [
					{
						key: 'github',
						kind: 'oauth',
						provider: 'github',
						description: 'Issues.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(merged.conflicts).toEqual([])
	expect(merged.needs).toEqual([
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'Read PRs.',
			multiple: false,
		},
	])

	const bothOmit = mergeCredentialNeeds({
		own: ownCredentialNeeds({ github: { description: 'A.' } }),
		dependencies: [
			{
				packageName: '@acme/other',
				needs: [
					{
						key: 'github',
						provider: 'github',
						description: 'B.',
						multiple: true,
					},
				],
			},
		],
	})
	expect(bothOmit.conflicts).toEqual([])
	expect(bothOmit.needs).toEqual([
		{
			key: 'github',
			provider: 'github',
			description: 'A.',
			multiple: true,
		},
	])

	const omitVsMcp = mergeCredentialNeeds({
		own: ownCredentialNeeds({ github: { description: 'A.' } }),
		dependencies: [
			{
				packageName: '@acme/mcp',
				needs: [
					{
						key: 'github',
						kind: 'mcp',
						provider: 'github',
						description: 'MCP.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(omitVsMcp.conflicts).toEqual([
		'kody.credentials.github: any fetch-capable kind from provider "github" (declared by this package) conflicts with mcp from provider "github" (declared by @acme/mcp). Give one of them a different key.',
	])
})

test('keys that are not provider slugs get a note, never an error', () => {
	expect(
		credentialNeedKeyNotes({
			github: { kind: 'oauth', description: 'x' },
			RESEND_API_KEY: { kind: 'secret', provider: 'resend', description: 'x' },
			MY_KEY: { kind: 'secret', description: 'x' },
		}),
	).toEqual([
		'kody.credentials.RESEND_API_KEY: keys usually name their provider; "resend" would read more clearly as the key.',
		'kody.credentials.MY_KEY: "MY_KEY" is not a provider slug (lowercase letters, numbers, hyphens), so no credential auto-resolves for it; callers pick one for this need instead.',
	])
})

test('a stored closure that does not parse counts as not stored', () => {
	expect(readStoredCredentialNeeds(null)).toBeNull()
	expect(readStoredCredentialNeeds([{ key: 'x' }])).toBeNull()
	expect(readStoredCredentialNeeds([])).toEqual([])
	expect(
		readStoredCredentialNeeds([
			{
				key: 'github',
				provider: 'github',
				description: 'Read PRs.',
				multiple: false,
			},
		]),
	).toEqual([
		{
			key: 'github',
			provider: 'github',
			description: 'Read PRs.',
			multiple: false,
		},
	])
})
