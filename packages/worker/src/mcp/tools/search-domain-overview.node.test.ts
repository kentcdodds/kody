import { expect, test } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { buildDomainOverviewMatches } from './search-domain-overview.ts'
import { understandSearchQuery } from './understand-search-query.ts'

function capability(name: string, domain: string, description: string) {
	return {
		name,
		domain,
		description,
		keywords: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: { type: 'object' as const, properties: {} },
		handler: async () => null,
	}
}

const registry = buildCapabilityRegistry([
	{
		name: 'email',
		description: 'Email primitives for the per-user inbox.',
		capabilities: [
			capability('email_send', 'email', 'Send a message.'),
			capability('email_message_list', 'email', 'List stored messages.'),
			capability('email_message_get', 'email', 'Get one stored message.'),
			capability('email_reply', 'email', 'Reply to a stored message.'),
		],
	},
	{
		name: 'jobs',
		description: 'Schedule durable work.',
		capabilities: [capability('job_schedule', 'jobs', 'Schedule a job.')],
	},
])

function overviewFor(query: string) {
	return buildDomainOverviewMatches({
		intent: understandSearchQuery({ query, entities: [] }),
		capabilityDomains: registry.capabilityDomains,
		capabilitySpecs: registry.capabilitySpecs,
	})
}

test('domain overviews cover named, plural, exploratory, and non-collapse cases', () => {
	expect(overviewFor('what can you do with email')).toEqual([
		{
			type: 'domain',
			name: 'email',
			title: 'email',
			description: 'Email primitives for the per-user inbox.',
			capabilityCount: 4,
			sampleCapabilities: [
				'email_send',
				'email_message_list',
				'email_message_get',
			],
		},
	])
	expect(overviewFor('email')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'email' }),
	])
	expect(overviewFor('what jobs exist')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'jobs' }),
	])
	expect(overviewFor('job')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'jobs' }),
	])
	expect(overviewFor('what can kody do')).toEqual([
		expect.objectContaining({ type: 'domain', name: 'email' }),
		expect.objectContaining({ type: 'domain', name: 'jobs' }),
	])
	expect(overviewFor('send an email to kent')).toBeNull()
	expect(overviewFor('list unread email from yesterday')).toBeNull()
	expect(overviewFor('spotify playlists')).toBeNull()

	const withoutJobsSpecs = Object.fromEntries(
		Object.entries(registry.capabilitySpecs).filter(
			([, spec]) => spec.domain !== 'jobs',
		),
	)
	expect(
		buildDomainOverviewMatches({
			intent: understandSearchQuery({
				query: 'what can kody do',
				entities: [],
			}),
			capabilityDomains: registry.capabilityDomains,
			capabilitySpecs: withoutJobsSpecs,
		}),
	).toEqual([expect.objectContaining({ type: 'domain', name: 'email' })])
	expect(
		buildDomainOverviewMatches({
			intent: understandSearchQuery({ query: 'email', entities: [] }),
			capabilityDomains: [],
			capabilitySpecs: registry.capabilitySpecs,
		}),
	).toBeNull()
})
