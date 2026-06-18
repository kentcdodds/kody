import { expect, test } from 'vitest'
import {
	buildPackageSearchProjection,
	parseAuthoredPackageJson,
} from './manifest.ts'

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
	).toThrow(
		'package.json name "@kentcdodds/cursor-cloud-agents" must use the authenticated user\'s package scope "@kody/*".',
	)

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
		'package.json name "@kentcdodds/cursor-cloud-agents" must use a leaf package name that matches kody.id "follow-up-on-pr-agent"',
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
	).toThrow(
		'package.json name "cursor-cloud-agents" must be a scoped package name like "@scope/cursor-cloud-agents".',
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
	).toThrow(
		'kody.workflows is not a supported field; use workflows.create({ packageId, exportName }) from any runtime context.',
	)

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
	).toThrow(
		'kody.emits topic "discord.message.created" must use the scoped form "@scope/topic.name"',
	)

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
	).toThrow(
		'kody.emits topic "@other/discord.message.created" must use the package scope "@kentcdodds"',
	)

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
