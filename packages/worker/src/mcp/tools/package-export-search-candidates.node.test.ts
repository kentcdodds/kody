import { expect, test, vi } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'

import { searchUnified, type PackageSearchRow } from './search.ts'
import { packageExportCandidateMinScore } from './search-constants.ts'
import {
	buildPackageActionMatches,
	hydrateTopPackageMatches,
	shouldPromotePackageExportCandidate,
} from './search-entity-plugins/package.ts'

function createPackageExportProjection(
	subpath: string,
	options: {
		description?: string
		typeDefinition?: string
		functionName?: string
		functionDescription?: string
	} = {},
) {
	return {
		subpath,
		runtimeTarget: null,
		typesPath: null,
		description: options.description ?? null,
		typeDefinition: options.typeDefinition ?? null,
		functions: options.functionName
			? [
					{
						name: options.functionName,
						description: options.functionDescription ?? null,
						typeDefinition: options.typeDefinition ?? null,
						referencedTypes: [],
					},
				]
			: [],
		referencedTypes: [],
	}
}

test('shouldPromotePackageExportCandidate requires multi-term or strong score', () => {
	expect(
		shouldPromotePackageExportCandidate({
			subpath: './weak',
			description: 'weak',
			typeDefinition: null,
			functions: [{ name: 'weak', description: null, typeDefinition: null }],
			score: 0.2,
			matchedTerms: ['weak'],
		}),
	).toBe(false)
	expect(
		shouldPromotePackageExportCandidate({
			subpath: './multi',
			description: 'multi',
			typeDefinition: null,
			functions: [{ name: 'multi', description: null, typeDefinition: null }],
			score: 0.2,
			matchedTerms: ['bond', 'shades'],
		}),
	).toBe(true)
	expect(
		shouldPromotePackageExportCandidate({
			subpath: './strong',
			description: 'strong',
			typeDefinition: null,
			functions: [{ name: 'strong', description: null, typeDefinition: null }],
			score: packageExportCandidateMinScore,
			matchedTerms: ['strong'],
		}),
	).toBe(true)
})

test('buildPackageActionMatches keeps nested display threshold below promotion', () => {
	const matches = buildPackageActionMatches({
		query: 'module-a',
		meaningfulTokens: ['module-a'],
		exports: [
			createPackageExportProjection('./module-a', {
				description: 'Run module-a task with distinctive wording.',
				functionName: 'runTask',
				functionDescription: 'Run module-a task with distinctive wording.',
				typeDefinition: 'export declare function runTask(): Promise<void>',
			}),
		],
	})
	expect(matches.length).toBeGreaterThan(0)
	const [top] = matches
	expect(top).toBeDefined()
	if (!top) return
	if (top.matchedTerms.length < 2) {
		expect(top.score).toBeGreaterThanOrEqual(0.35)
		expect(shouldPromotePackageExportCandidate(top)).toBe(
			top.score >= packageExportCandidateMinScore,
		)
	}
})

test('searchUnified promotes strong package exports into first-pass ranked hits', async () => {
	const registry = buildCapabilityRegistry([])
	const packageRow = {
		record: {
			id: 'pkg-alpha',
			userId: 'user-1',
			name: '@kody/pkg-alpha',
			kodyId: 'pkg-alpha',
			description: 'Alpha helpers.',
			tags: ['alpha', 'module-a'],
			searchText: 'module-a module-b helpers',
			sourceId: 'source-alpha',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '2026-04-20T00:00:00.000Z',
			updatedAt: '2026-04-20T00:00:00.000Z',
		},
		listingAhead: null,
		projection: {
			name: '@kody/pkg-alpha',
			kodyId: 'pkg-alpha',
			description: 'Alpha helpers.',
			tags: ['alpha', 'module-a'],
			searchText: 'module-a module-b helpers',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			appEntry: null,
			exports: [
				createPackageExportProjection('./module-a', {
					description: 'Run module-a task.',
					functionName: 'runTask',
					functionDescription: 'Run module-a task.',
					typeDefinition:
						'export declare function runTask(params: TaskParams): Promise<JsonObject>',
				}),
				createPackageExportProjection('./module-b', {
					description: 'Search module-b records.',
					functionName: 'searchRecords',
					functionDescription: 'Search module-b records.',
				}),
			],
			jobs: [],
			subscriptions: [],
			retrievers: [],
			webhooks: [],
		},
	}
	const result = await searchUnified({
		env: {} as Env,
		query: 'module-a run task',
		userId: 'user-1',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [packageRow],
			userSecretRows: [],
			userValueRows: [],
			userIntegrationRows: [],
		},
	})

	const exportMatch = result.matches.find(
		(match) => match.type === 'package' && match.exportSubpath === './module-a',
	)
	expect(exportMatch).toMatchObject({
		type: 'package',
		kodyId: 'pkg-alpha',
		exportSubpath: './module-a',
		actionMatches: [
			expect.objectContaining({
				subpath: './module-a',
				functions: [
					expect.objectContaining({
						name: 'runTask',
					}),
				],
			}),
		],
	})
	const packageIndexMatch = result.matches.find(
		(match) =>
			match.type === 'package' &&
			match.kodyId === 'pkg-alpha' &&
			match.exportSubpath == null,
	)
	expect(packageIndexMatch).toMatchObject({
		type: 'package',
		kodyId: 'pkg-alpha',
	})
	expect(packageIndexMatch?.actionMatches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subpath: './module-a',
				functions: [
					expect.objectContaining({
						name: 'runTask',
					}),
				],
			}),
		]),
	)
	const broadQuery = await searchUnified({
		env: {} as Env,
		query: 'alpha helpers overview',
		userId: 'user-1',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [
				{
					...packageRow,
					projection: {
						...packageRow.projection,
						exports: [
							createPackageExportProjection('./module-a', {
								description: 'Run module-a task.',
								functionName: 'runTask',
							}),
							createPackageExportProjection('./unrelated-widget', {
								description: 'Spin the unrelated widget thrice.',
								functionName: 'spinWidget',
								functionDescription: 'Spin the unrelated widget thrice.',
							}),
						],
					},
				},
			],
			userSecretRows: [],
			userValueRows: [],
			userIntegrationRows: [],
		},
	})
	const broadPackageMatches = broadQuery.matches.filter(
		(match) => match.type === 'package',
	)
	expect(
		broadPackageMatches.every((match) => match.exportSubpath == null),
	).toBe(true)
	const broadPackageMatch = broadPackageMatches.find(
		(match) => match.kodyId === 'pkg-alpha',
	)
	expect(broadPackageMatch).toMatchObject({
		type: 'package',
		kodyId: 'pkg-alpha',
		actionMatches: [],
	})
})

test('searchUnified hydrates lean package rows before promoting export candidates', async () => {
	const registry = buildCapabilityRegistry([])
	const exportDescription = 'Dim bond area shades for evening.'
	const hydrate = vi.fn(async () => ({
		projection: {
			name: '@kody/home-controls',
			kodyId: 'home-controls',
			description: 'Home controls package.',
			tags: ['home', 'shades'],
			searchText: null,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			appEntry: null,
			exports: [
				createPackageExportProjection('./bond-area-shades', {
					description: exportDescription,
					functionName: 'setBondAreaShades',
					functionDescription: exportDescription,
				}),
			],
			jobs: [],
			subscriptions: [],
			retrievers: [],
			webhooks: [],
		},
		readmeSnippet: null,
	}))
	const leanRow: PackageSearchRow = {
		record: {
			id: 'home-controls-pkg',
			userId: 'user-1',
			name: '@kody/home-controls',
			kodyId: 'home-controls',
			description: 'Home controls package.',
			tags: ['home', 'shades', 'bond-area-shades'],
			searchText: 'bond area shades',
			sourceId: 'source-home-controls',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '2026-04-20T00:00:00.000Z',
			updatedAt: '2026-04-20T00:00:00.000Z',
		},
		listingAhead: null,
		projection: {
			name: '@kody/home-controls',
			kodyId: 'home-controls',
			description: 'Home controls package.',
			tags: ['home', 'shades', 'bond-area-shades'],
			searchText: 'bond area shades',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			appEntry: null,
			exports: [],
			jobs: [],
			subscriptions: [],
			retrievers: [],
			webhooks: [],
		},
		readmeSnippet: null,
		hydrate,
	}
	const result = await searchUnified({
		env: {} as Env,
		query: 'bond area shades set',
		userId: 'user-1',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [leanRow],
			userSecretRows: [],
			userValueRows: [],
			userIntegrationRows: [],
		},
	})
	expect(hydrate).toHaveBeenCalled()
	expect(
		result.matches.some(
			(match) =>
				match.type === 'package' &&
				match.exportSubpath === './bond-area-shades',
		),
	).toBe(true)
})

test('hydrateTopPackageMatches keeps export hits aligned with exportSubpath', async () => {
	const hydrate = vi.fn(async () => ({
		projection: {
			name: '@kody/home-controls',
			kodyId: 'home-controls',
			description: 'Home controls package.',
			tags: ['home'],
			searchText: null,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			appEntry: null,
			exports: [
				createPackageExportProjection('./bond-area-shades', {
					description: 'Dim bond area shades.',
					functionName: 'setBondAreaShades',
					functionDescription: 'Dim bond area shades.',
				}),
				createPackageExportProjection('./other-export', {
					description: 'Unrelated other export helpers.',
					functionName: 'otherHelper',
					functionDescription: 'Unrelated other export helpers.',
				}),
			],
			jobs: [],
			subscriptions: [],
			retrievers: [],
			webhooks: [],
		},
		readmeSnippet: {
			path: 'README.md',
			snippet: 'Home controls intent.',
			truncated: false,
		},
	}))
	const match = {
		type: 'package' as const,
		packageId: 'home-controls-pkg',
		kodyId: 'home-controls',
		name: '@kody/home-controls',
		title: '@kody/home-controls setBondAreaShades',
		description: 'Dim bond area shades.',
		tags: ['home'],
		hasApp: false,
		hidden: false,
		exportSubpath: './bond-area-shades',
		actionMatches: [
			{
				subpath: './bond-area-shades',
				description: 'Dim bond area shades.',
				typeDefinition: null,
				functions: [
					{
						name: 'setBondAreaShades',
						description: 'Dim bond area shades.',
						typeDefinition: null,
					},
				],
				score: 0.9,
				matchedTerms: ['bond', 'area', 'shades'],
			},
		],
	}
	await hydrateTopPackageMatches({
		query: 'bond area shades set',
		matches: [match],
		rows: [
			{
				record: {
					id: 'home-controls-pkg',
					userId: 'user-1',
					name: '@kody/home-controls',
					kodyId: 'home-controls',
					description: 'Home controls package.',
					tags: ['home'],
					searchText: null,
					sourceId: 'source-home',
					hasApp: false,
					hidden: false,
					isPrivate: false,
					createdAt: '2026-04-20T00:00:00.000Z',
					updatedAt: '2026-04-20T00:00:00.000Z',
				},
				listingAhead: null,
				projection: {
					name: '@kody/home-controls',
					kodyId: 'home-controls',
					description: 'Home controls package.',
					tags: ['home'],
					searchText: null,
					hasApp: false,
					hidden: false,
					isPrivate: false,
					appEntry: null,
					exports: [],
					jobs: [],
					subscriptions: [],
					retrievers: [],
					webhooks: [],
				},
				readmeSnippet: null,
				hydrate,
			},
		],
	})
	expect(hydrate).toHaveBeenCalled()
	expect(match.actionMatches).toEqual([
		expect.objectContaining({
			subpath: './bond-area-shades',
			functions: [expect.objectContaining({ name: 'setBondAreaShades' })],
		}),
	])
	expect(match.actionMatches).toHaveLength(1)
	expect(match.readmeSnippet).toMatchObject({
		path: 'README.md',
		snippet: 'Home controls intent.',
	})
})
