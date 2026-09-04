import { expect, test } from 'vitest'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { importGuideCatalog } from '#worker/guide-catalog-modules.ts'

import { searchUnified } from '../search-core.ts'
import { buildSearchableEntityDescriptors } from '../search-descriptors.ts'
import { formatEntityDetailMarkdown } from '../search-format-detail.ts'
import { formatSearchMarkdown } from '../search-format-list.ts'
import { toSlimStructuredMatches } from '../search-format-slim.ts'
import { guideSearchEntityPlugin } from './guide.ts'

const emptyOptionalRows = {
	packageRows: [],
	userSecretRows: [],
	userValueRows: [],
	userIntegrationRows: [],
}

test('guide search entities rank advertised docs and open full markdown on entity detail', async () => {
	const descriptors = guideSearchEntityPlugin.buildDescriptors!({
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(descriptors.some((descriptor) => descriptor.id === 'values')).toBe(
		false,
	)
	expect(
		descriptors.some(
			(descriptor) => descriptor.id === 'package_invocation_token_setup',
		),
	).toBe(false)

	const authoringCandidates = await guideSearchEntityPlugin.buildCandidates!({
		env: {} as Env,
		query: 'package authoring',
		limit: 15,
		offline: true,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
		retrieverResults: [],
		queryEmbedding: [],
	})
	expect(
		authoringCandidates.some(
			(candidate) => candidate.id === 'package_authoring',
		),
	).toBe(true)
	expect(
		authoringCandidates.some((candidate) => candidate.id === 'values'),
	).toBe(false)
	expect(
		authoringCandidates.some(
			(candidate) => candidate.id === 'package_invocation_token_setup',
		),
	).toBe(false)

	const emailScoped = await guideSearchEntityPlugin.buildCandidates!({
		env: {} as Env,
		query: 'package authoring',
		limit: 15,
		offline: true,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
		retrieverResults: [],
		queryEmbedding: [],
		domain: 'email',
	})
	expect(emailScoped).toEqual([])

	const codingScoped = await guideSearchEntityPlugin.buildCandidates!({
		env: {} as Env,
		query: 'package authoring',
		limit: 15,
		offline: true,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
		retrieverResults: [],
		queryEmbedding: [],
		domain: capabilityDomainNames.coding,
	})
	expect(
		codingScoped.some((candidate) => candidate.id === 'package_authoring'),
	).toBe(true)

	const ranked = await searchUnified({
		env: {} as Env,
		query: 'package authoring',
		limit: 10,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(ranked.matches[0]).toMatchObject({
		type: 'guide',
		id: 'package_authoring',
	})

	const authoringMatch = authoringCandidates.find(
		(candidate) => candidate.id === 'package_authoring',
	)
	expect(authoringMatch).toBeDefined()
	const slim = toSlimStructuredMatches({
		baseUrl: 'https://kody.codes',
		matches: [authoringMatch!.match],
	})
	expect(slim).toEqual([
		expect.objectContaining({
			type: 'guide',
			id: 'package_authoring',
			entityRef: 'package_authoring:guide',
			usage: 'search({ entity: "package_authoring:guide" })',
		}),
	])

	const markdown = formatSearchMarkdown({
		matches: [authoringMatch!.match],
	})
	expect(markdown).toContain('package_authoring:guide')

	const { guides } = await importGuideCatalog()
	const loaded =
		guides.find((guide) => guide.id === 'package_authoring') ?? null
	expect(loaded).not.toBeNull()
	const detail = formatEntityDetailMarkdown({
		type: 'guide',
		id: loaded!.id,
		title: loaded!.title,
		description: loaded!.summary,
		body: loaded!.body,
		slug: loaded!.slug,
		category: loaded!.category,
		provider: loaded!.provider,
		lastVerified: loaded!.lastVerified,
	})
	expect(detail.markdown).toContain(loaded!.body.slice(0, 40))
	expect(detail.structured).toMatchObject({
		kind: 'entity',
		type: 'guide',
		entityRef: 'package_authoring:guide',
		body: loaded!.body,
	})

	expect(
		buildSearchableEntityDescriptors({
			registry: { capabilitySpecs: {} } as never,
			optionalRows: emptyOptionalRows,
			domain: 'email',
		}).filter((descriptor) => descriptor.type === 'guide'),
	).toEqual([])

	const taskQuery = await searchUnified({
		env: {} as Env,
		query: 'send an email to kent',
		limit: 10,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(taskQuery.matches.every((match) => match.type !== 'guide')).toBe(true)

	const integrationIdentity = await searchUnified({
		env: {} as Env,
		query: 'google-calendar',
		limit: 10,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(
		integrationIdentity.matches.some(
			(match) => match.type === 'guide' && match.id === 'provider_google',
		),
	).toBe(false)

	const documentedDiscovery = await searchUnified({
		env: {} as Env,
		query: 'package authoring lifecycle',
		limit: 10,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(
		documentedDiscovery.matches.some(
			(match) => match.type === 'guide' && match.id === 'package_authoring',
		),
	).toBe(true)
	expect(
		documentedDiscovery.matches.some(
			(match) => match.type === 'guide' && match.id === 'package_lifecycle',
		),
	).toBe(true)

	const suffixDiscovery = await searchUnified({
		env: {} as Env,
		query: 'google guide',
		limit: 10,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(
		suffixDiscovery.matches.some(
			(match) => match.type === 'guide' && match.id === 'provider_google',
		),
	).toBe(true)

	const howKodyWorks = await searchUnified({
		env: {} as Env,
		query: 'how kody works',
		limit: 10,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(
		howKodyWorks.matches.some(
			(match) => match.type === 'guide' && match.id === 'how_kody_works',
		),
	).toBe(true)

	const stopwordInId = await searchUnified({
		env: {} as Env,
		query: 'what is kody',
		limit: 10,
		registry: { capabilitySpecs: {} } as never,
		optionalRows: emptyOptionalRows,
	})
	expect(
		stopwordInId.matches.every(
			(match) => match.type !== 'guide' || match.id !== 'first_win',
		),
	).toBe(true)
})
