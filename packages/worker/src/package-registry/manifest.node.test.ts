import { expect, test } from 'vitest'
import {
	buildPackageSearchProjection,
	listPackageEmittedEvents,
	parseAuthoredPackageJson,
} from './manifest.ts'
import {
	assertKodyDescriptionLength,
	KODY_DESCRIPTION_MAX_LENGTH,
} from './types.ts'

test('parseAuthoredPackageJson validates scoped package names against kody.id', () => {
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/cursor-cloud-agents',
			exports: {
				'.': './index.ts',
			},
			kody: {
				id: 'cursor-cloud-agents',
				description: 'Cursor cloud agents package',
			},
		}),
		manifestPath: 'package.json',
		expectedPackageScope: 'kentcdodds',
	})

	expect(manifest.name).toBe('@kentcdodds/cursor-cloud-agents')
	expect(manifest.kody.id).toBe('cursor-cloud-agents')

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/cursor-cloud-agents',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'cursor-cloud-agents',
					description: 'Wrong package scope',
				},
			}),
			manifestPath: 'package.json',
			expectedPackageScope: 'kody',
		}),
	).toThrow(/must use the authenticated user's package scope "@kody\/\*"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/cursor-cloud-agents',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'follow-up-on-pr-agent',
					description: 'Mismatched package id',
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(
		/must use a leaf package name that matches kody\.id "follow-up-on-pr-agent"/,
	)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: 'cursor-cloud-agents',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'cursor-cloud-agents',
					description: 'Unscoped package name',
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/must be a scoped package name/)

	const tooLongForWrite = 'a'.repeat(KODY_DESCRIPTION_MAX_LENGTH + 1)
	const longDescription = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/long-description',
			exports: {
				'.': './index.ts',
			},
			kody: {
				id: 'long-description',
				description: tooLongForWrite,
			},
		}),
		manifestPath: 'package.json',
	})
	expect(longDescription.kody.description).toBe(tooLongForWrite)
	expect(() => assertKodyDescriptionLength('a'.repeat(200))).not.toThrow()
	expect(() => assertKodyDescriptionLength('a'.repeat(201))).toThrow(
		/kody\.description must be at most 200 characters/,
	)
})

test('parseAuthoredPackageJson accepts services, subscriptions, emits, retrievers, and secret mounts', () => {
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/discord-gateway',
			exports: {
				'.': './index.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway package',
				secretMounts: {
					discordBotToken: {
						name: 'discordBotTokenKentPersonalAutomation',
						scope: 'user',
					},
				},
				services: {
					'gateway-supervisor': {
						entry: './src/gateway-supervisor.ts',
						autoStart: true,
						mode: 'persistent',
						timeoutMs: 300000,
					},
				},
				subscriptions: {
					'discord.message.created': {
						handler: './src/handle-discord-message-created.ts',
						description: 'Personal-history subscriber',
						filters: {
							channelIds: ['1470913684598423592'],
						},
					},
				},
				emits: {
					'@kentcdodds/discord.message.created': {
						description: 'A Discord message was created.',
					},
				},
				retrievers: {
					'notes-search': {
						export: './search-notes',
						name: 'Personal notes',
						description: 'Searches saved notes and snippets.',
						scopes: ['context', 'search'],
						timeoutMs: 250,
						maxResults: 3,
					},
				},
			},
		}),
		manifestPath: 'package.json',
	})

	expect(manifest.kody.secretMounts).toEqual({
		discordBotToken: {
			name: 'discordBotTokenKentPersonalAutomation',
			scope: 'user',
		},
	})
	expect(manifest.kody.services).toEqual({
		'gateway-supervisor': {
			entry: './src/gateway-supervisor.ts',
			autoStart: true,
			mode: 'persistent',
			timeoutMs: 300000,
		},
	})
	expect(manifest.kody.subscriptions).toEqual({
		'discord.message.created': {
			handler: './src/handle-discord-message-created.ts',
			description: 'Personal-history subscriber',
			filters: {
				channelIds: ['1470913684598423592'],
			},
		},
	})
	expect(manifest.kody.emits).toEqual({
		'@kentcdodds/discord.message.created': {
			description: 'A Discord message was created.',
		},
	})
	expect(listPackageEmittedEvents(manifest)).toEqual([
		{
			topic: '@kentcdodds/discord.message.created',
			description: 'A Discord message was created.',
			payloadSchema: null,
		},
	])

	const withPayloadSchema = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/discord-gateway',
			exports: {
				'.': './index.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway package',
				emits: {
					'@kentcdodds/discord.message.created': {
						description: 'A Discord message was created.',
						payloadSchema: {
							type: 'object',
							properties: {
								messageId: { type: 'string', minLength: 1 },
							},
							required: ['messageId'],
							additionalProperties: false,
						},
					},
				},
			},
		}),
		manifestPath: 'package.json',
	})
	expect(listPackageEmittedEvents(withPayloadSchema)).toEqual([
		{
			topic: '@kentcdodds/discord.message.created',
			description: 'A Discord message was created.',
			payloadSchema: {
				type: 'object',
				properties: {
					messageId: { type: 'string', minLength: 1 },
				},
				required: ['messageId'],
				additionalProperties: false,
			},
		},
	])
	expect(buildPackageSearchProjection(manifest).retrievers).toEqual([
		{
			key: 'notes-search',
			exportName: './search-notes',
			name: 'Personal notes',
			description: 'Searches saved notes and snippets.',
			scopes: ['context', 'search'],
			timeoutMs: 250,
			maxResults: 3,
		},
	])
})

test('parseAuthoredPackageJson accepts kody.webhooks and rejects unknown exports or duplicate names', () => {
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						name: 'sentry',
						export: './handle-sentry-webhook',
						responseMode: 'ack',
						verification: {
							type: 'hmac-sha256',
							header: 'sentry-hook-signature',
							secretName: 'sentryWebhookSecret',
							encoding: 'hex',
						},
					},
				],
			},
		}),
		manifestPath: 'package.json',
	})
	expect(buildPackageSearchProjection(manifest).webhooks).toEqual([
		{
			name: 'sentry',
			exportName: './handle-sentry-webhook',
			description: null,
			responseMode: 'ack',
			verification: {
				type: 'hmac-sha256',
				header: 'sentry-hook-signature',
				secretName: 'sentryWebhookSecret',
				encoding: 'hex',
			},
		},
	])

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/sentry-bridge',
				exports: { '.': './index.ts' },
				kody: {
					id: 'sentry-bridge',
					description: 'Sentry bridge',
					webhooks: [
						{
							name: 'sentry',
							export: './missing-export',
						},
					],
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/export "\.\/missing-export"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/sentry-bridge',
				exports: {
					'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
				},
				kody: {
					id: 'sentry-bridge',
					description: 'Sentry bridge',
					webhooks: [
						{ name: 'sentry', export: './handle-sentry-webhook' },
						{ name: 'sentry', export: './handle-sentry-webhook' },
					],
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/Duplicate webhook name/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/sentry-bridge',
				exports: {
					'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
				},
				kody: {
					id: 'sentry-bridge',
					description: 'Sentry bridge',
					webhooks: [
						{
							name: 'sentry',
							export: './handle-sentry-webhook',
							verification: {
								type: 'hmac-sha256',
								header: 'bad header\nname',
								secretName: 'sentryWebhookSecret',
								encoding: 'hex',
							},
						},
					],
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/header/)
})

test('parseAuthoredPackageJson rejects unsupported or invalid kody manifest extensions', () => {
	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/shade-automation',
				exports: {
					'./run-event': './src/run-event.ts',
				},
				kody: {
					id: 'shade-automation',
					description: 'Shade automation package',
					workflows: {
						'shade-event': {
							export: './run-event',
						},
					},
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/kody\.workflows is not a supported field/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/realtime-supervisor',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'realtime-supervisor',
					description: 'Realtime supervisor package',
					services: {
						'realtime-supervisor': {
							entry: './services/realtime-supervisor.ts',
							timeoutMs: 300001,
						},
					},
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow('expected number to be <=300000')

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway package',
					emits: {
						'discord.message.created': {
							description: 'A Discord message was created.',
						},
					},
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/must use the scoped form "@scope\/topic\.name"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway package',
					emits: {
						'@other/discord.message.created': {
							description: 'A Discord message was created.',
						},
					},
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/must use the package scope "@kentcdodds"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway package',
					emits: {
						'@kentcdodds/discord.message.created': {
							description: 'A Discord message was created.',
							payloadSchema: { type: 'string' },
						},
					},
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/payloadSchema must declare "type": "object"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway package',
					emits: {
						'@kentcdodds/discord.message.created': {
							description: 'A Discord message was created.',
							payloadSchema: {
								type: 'object',
								properties: {
									messageId: { type: 'string', pattern: '^[0-9]+$' },
								},
							},
						},
					},
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow(/payloadSchema is not a supported JSON Schema subset/)

	expect(() =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/personal-inbox',
				exports: {
					'.': './index.ts',
					'./search-notes': './src/search-notes.ts',
				},
				kody: {
					id: 'personal-inbox',
					description: 'Personal inbox for random notes',
					retrievers: {
						'notes-search': {
							export: './search-notes',
							name: 'Personal notes',
							description: 'Searches saved notes and snippets.',
							scopes: [],
						},
					},
				},
			}),
			manifestPath: 'package.json',
		}),
	).toThrow('Too small')
})

test('buildPackageSearchProjection extracts export metadata, referenced types, and search documents', () => {
	const weatherManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/weather-tools',
			exports: {
				'.': {
					import: './src/index.ts',
					types: './src/index.d.ts',
				},
			},
			kody: {
				id: 'weather-tools',
				description: 'Weather tools package',
			},
		}),
		manifestPath: 'package.json',
	})

	const weatherProjection = buildPackageSearchProjection(weatherManifest, {
		'src/index.ts':
			'export const ignored = "types file should be preferred for metadata"',
		'src/index.d.ts': `/**
 * Look up the forecast for a city.
 */
export declare function forecast(city: string): Promise<string>

/**
 * Convert Celsius to Fahrenheit.
 */
export declare const celsiusToFahrenheit: (value: number) => number
`,
	})

	expect(weatherProjection.exports).toEqual([
		expect.objectContaining({
			subpath: '.',
			runtimeTarget: 'src/index.ts',
			typesPath: 'src/index.d.ts',
			description: 'Look up the forecast for a city.',
			functions: [
				{
					name: 'forecast',
					description: 'Look up the forecast for a city.',
					typeDefinition:
						'export declare function forecast(city: string): Promise<string>',
					referencedTypes: [],
				},
				{
					name: 'celsiusToFahrenheit',
					description: 'Convert Celsius to Fahrenheit.',
					typeDefinition:
						'export declare const celsiusToFahrenheit: (value: number) => number',
					referencedTypes: [],
				},
			],
			referencedTypes: [],
		}),
	])

	const cursorManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/cursor-cloud-agents',
			exports: {
				'./launch-cursor-cloud-agent': {
					import: './src/launch-cursor-cloud-agent.ts',
					types: './src/launch-cursor-cloud-agent.d.ts',
				},
			},
			kody: {
				id: 'cursor-cloud-agents',
				description: 'Cursor cloud agents package',
			},
		}),
		manifestPath: 'package.json',
	})

	const cursorProjection = buildPackageSearchProjection(cursorManifest, {
		'src/launch-cursor-cloud-agent.d.ts': `type LaunchCursorCloudAgentInput = {
	prompt: string
	repository: RepositoryTarget
	mode?: LaunchMode
	metadata?: Record<string, string>
	createdAt?: Date
}

interface RepositoryTarget {
	owner: string
	repo: string
}

enum LaunchMode {
	Background = 'background',
	Interactive = 'interactive',
}

type UnrelatedLocalType = {
	ignored: boolean
}

/**
 * Launch a Cursor Cloud agent.
 */
export declare function launch(input: LaunchCursorCloudAgentInput): Promise<Response>
`,
	})

	const [exportDetail] = cursorProjection.exports
	expect(exportDetail).toMatchObject({
		subpath: './launch-cursor-cloud-agent',
		functions: [
			expect.objectContaining({
				name: 'launch',
				description: 'Launch a Cursor Cloud agent.',
				typeDefinition:
					'export declare function launch(input: LaunchCursorCloudAgentInput): Promise<Response>',
			}),
		],
	})
	expect(exportDetail?.referencedTypes.map((type) => type.name)).toEqual([
		'LaunchCursorCloudAgentInput',
		'RepositoryTarget',
		'LaunchMode',
	])
	expect(exportDetail?.referencedTypes.map((type) => type.kind)).toEqual([
		'type',
		'interface',
		'enum',
	])
	expect(
		exportDetail?.referencedTypes.every((type) => type.definition.length > 0),
	).toBe(true)
	expect(exportDetail?.functions[0]?.referencedTypes).toEqual(
		exportDetail?.referencedTypes,
	)
	const referencedTypeText = exportDetail?.referencedTypes
		.map((type) => type.definition)
		.join('\n')
	expect(referencedTypeText).not.toContain('UnrelatedLocalType')
	expect(referencedTypeText).not.toContain('type Record')
	expect(referencedTypeText).not.toContain('type Date')
	expect(referencedTypeText).not.toContain('interface Response')

	const mixedManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/mixed-runtime-tools',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'mixed-runtime-tools',
				description: 'Mixed runtime tools package',
			},
		}),
		manifestPath: 'package.json',
	})

	const mixedProjection = buildPackageSearchProjection(mixedManifest, {
		'src/index.ts': `type GenericBound = {
	value: string
}

type RenderedInput = {
	value: string
}

/**
 * Package version metadata.
 */
export declare const VERSION: string

export declare const typed: (value: string) => string

export declare const typedGeneric: <T extends RenderedInput>(input: T) => string

/**
 * Runtime formatter.
 */
export const format = (value: string): string => value.trim()

export const genericFormat = <T extends GenericBound>(input: T): string => input.value
`,
	})

	expect(mixedProjection.exports[0]?.functions.map((fn) => fn.name)).toEqual([
		'typed',
		'typedGeneric',
		'format',
		'genericFormat',
	])
	expect(
		mixedProjection.exports[0]?.functions
			.find((fn) => fn.name === 'typedGeneric')
			?.referencedTypes.map((type) => type.name),
	).toEqual(['RenderedInput'])
	expect(
		mixedProjection.exports[0]?.referencedTypes.map((type) => type.name),
	).toEqual(['RenderedInput'])

	const largeManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/large-type-tools',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'large-type-tools',
				description: 'Large type tools package',
			},
		}),
		manifestPath: 'package.json',
	})
	const oversizedFields = Array.from(
		{ length: 1_500 },
		(_, index) => `	field${index}: string`,
	).join('\n')

	const largeProjection = buildPackageSearchProjection(largeManifest, {
		'src/index.ts': `type HugeInput = {
${oversizedFields}
}

type SmallInput = {
	value: string
}

export function run(huge: HugeInput, small: SmallInput): string {
	return small.value
}
`,
	})

	expect(
		largeProjection.exports[0]?.referencedTypes.map((type) => type.name),
	).toEqual(['SmallInput'])
	expect(
		largeProjection.exports[0]?.referencedTypes.every(
			(type) => type.definition.length > 0,
		),
	).toBe(true)

	const emailManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/email-notifier',
			exports: {
				'.': './index.ts',
			},
			kody: {
				id: 'email-notifier',
				description: 'Email notifier package',
				subscriptions: {
					'email.message.received': {
						handler: './src/handle-received-email.ts',
						description: 'Notify on accepted inbound email',
						filters: {
							policy_decisions: ['accepted'],
						},
					},
					'email.message.quarantined': {
						handler: './src/handle-quarantined-email.ts',
					},
				},
			},
		}),
		manifestPath: 'package.json',
	})

	const emailProjection = buildPackageSearchProjection(emailManifest)

	expect(emailProjection.subscriptions).toEqual([
		{
			topic: 'email.message.quarantined',
			handler: 'src/handle-quarantined-email.ts',
			description: null,
			filters: null,
		},
		{
			topic: 'email.message.received',
			handler: 'src/handle-received-email.ts',
			description: 'Notify on accepted inbound email',
			filters: {
				policy_decisions: ['accepted'],
			},
		},
	])
})

test('buildPackageSearchProjection follows local default-export bindings and one-hop imported types', () => {
	const spotifyManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/spotify-like-tools',
			exports: {
				'./search': './src/search.ts',
			},
			kody: {
				id: 'spotify-like-tools',
				description: 'Spotify-like thin-export package',
			},
		}),
		manifestPath: 'package.json',
	})

	const spotifyProjection = buildPackageSearchProjection(spotifyManifest, {
		'src/search.ts': `import type { SearchParams } from '../lib/export-types.ts'
import { searchCatalog } from '../lib/search-catalog.ts'

/**
 * Search the Spotify catalog.
 */
async function spotifySearch(params: SearchParams = {}) {
	return await searchCatalog(params)
}

export default spotifySearch
`,
		'lib/export-types.ts': `import type { PagingParams } from './paging.ts'

export type SearchParams = {
	q?: string
	types?: Array<'album' | 'artist' | 'track'>
	limit?: number
	paging?: PagingParams
}

export type UnrelatedExportType = {
	ignored: boolean
}
`,
		'lib/paging.ts': `export type PagingParams = {
	offset?: number
}
`,
		'lib/search-catalog.ts': `export async function searchCatalog(params: { q?: string }) {
	return params
}
`,
	})

	const [spotifyExport] = spotifyProjection.exports
	expect(spotifyExport?.functions.map((fn) => fn.name)).toEqual(['default'])
	expect(spotifyExport?.typeDefinition).toContain('spotifySearch')
	expect(spotifyExport?.referencedTypes.map((type) => type.name)).toEqual([
		'SearchParams',
	])
	expect(spotifyExport?.referencedTypes[0]?.kind).toBe('type')
	expect(spotifyExport?.referencedTypes[0]?.definition).toContain('q?: string')
	expect(spotifyExport?.referencedTypes.map((type) => type.name)).not.toContain(
		'PagingParams',
	)
	expect(spotifyExport?.referencedTypes.map((type) => type.name)).not.toContain(
		'UnrelatedExportType',
	)

	const arrowDefaultManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/arrow-default-tools',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'arrow-default-tools',
				description: 'Local arrow default export',
			},
		}),
		manifestPath: 'package.json',
	})
	const arrowDefaultProjection = buildPackageSearchProjection(
		arrowDefaultManifest,
		{
			'src/index.ts': `import type { SearchParams } from '../lib/export-types.ts'

/**
 * Search with a local arrow binding.
 */
const search = async (params: SearchParams = {}) => params

export default search
`,
			'lib/export-types.ts': `export type SearchParams = {
	q?: string
}
`,
		},
	)
	expect(arrowDefaultProjection.exports[0]?.functions[0]?.name).toBe('default')
	expect(
		arrowDefaultProjection.exports[0]?.referencedTypes.map((type) => type.name),
	).toEqual(['SearchParams'])

	const jsDocFallbackManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/jsdoc-fallback-tools',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'jsdoc-fallback-tools',
				description: 'JSDoc fallback on export default',
			},
		}),
		manifestPath: 'package.json',
	})
	const jsDocFallbackProjection = buildPackageSearchProjection(
		jsDocFallbackManifest,
		{
			'src/index.ts': `async function search(query: string) {
	return query
}

/**
 * Docs live on the export default line.
 */
export default search
`,
		},
	)
	expect(jsDocFallbackProjection.exports[0]?.typeDefinition).toContain(
		'search(query: string)',
	)
	expect(jsDocFallbackProjection.exports[0]?.description).toBeTruthy()

	const reexportManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/reexport-tools',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'reexport-tools',
				description: 'Imported value re-export package',
			},
		}),
		manifestPath: 'package.json',
	})
	const reexportProjection = buildPackageSearchProjection(reexportManifest, {
		'src/index.ts': `import foo from './other.ts'

/**
 * Should not be attributed to an imported re-export.
 */
export default foo
`,
		'src/other.ts': `/**
 * Implemented in another module.
 */
export default async function foo(params: { q: string }) {
	return params
}
`,
	})
	expect(reexportProjection.exports[0]).toMatchObject({
		description: null,
		typeDefinition: null,
		functions: [],
		referencedTypes: [],
	})

	const namedPlusDefaultManifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/named-plus-default-tools',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'named-plus-default-tools',
				description: 'Named export also re-exported as default',
			},
		}),
		manifestPath: 'package.json',
	})
	const namedPlusDefaultProjection = buildPackageSearchProjection(
		namedPlusDefaultManifest,
		{
			'src/index.ts': `/**
 * Look up a city forecast.
 */
export async function forecast(city: string): Promise<string> {
	return city
}

export default forecast
`,
		},
	)
	expect(namedPlusDefaultProjection.exports[0]?.functions).toEqual([
		expect.objectContaining({ name: 'forecast' }),
	])
})
