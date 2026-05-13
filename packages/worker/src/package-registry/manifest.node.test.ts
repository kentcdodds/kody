import { expect, test } from 'vitest'
import {
	buildPackageSearchDocument,
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

test('parseAuthoredPackageJson accepts package service definitions', () => {
	const manifest = parseAuthoredPackageJson({
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
						autoStart: true,
						timeoutMs: 300000,
					},
				},
			},
		}),
		manifestPath: 'package.json',
	})

	expect(manifest.kody.services).toEqual({
		'realtime-supervisor': {
			entry: './services/realtime-supervisor.ts',
			autoStart: true,
			timeoutMs: 300000,
		},
	})
})

test('parseAuthoredPackageJson rejects legacy kody.workflows declarations with a clear migration error', () => {
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
})

test('parseAuthoredPackageJson rejects service timeoutMs values above the supported maximum', () => {
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
})

test('parseAuthoredPackageJson accepts secret mounts and subscriptions', () => {
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
})

test('parseAuthoredPackageJson accepts retriever definitions and includes them in search projection', () => {
	const manifest = parseAuthoredPackageJson({
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
						scopes: ['context', 'search'],
						timeoutMs: 250,
						maxResults: 3,
					},
				},
			},
		}),
		manifestPath: 'package.json',
	})

	const projection = buildPackageSearchProjection(manifest)

	expect(projection.retrievers).toEqual([
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

test('buildPackageSearchProjection includes exported function signatures and jsdoc', () => {
	const manifest = parseAuthoredPackageJson({
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

	const projection = buildPackageSearchProjection(manifest, {
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

	expect(projection.exports).toEqual([
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
})

test('buildPackageSearchProjection includes only referenced local named types', () => {
	const manifest = parseAuthoredPackageJson({
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

	const projection = buildPackageSearchProjection(manifest, {
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

	const [exportDetail] = projection.exports
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
	expect(exportDetail?.referencedTypes).toEqual([
		{
			name: 'LaunchCursorCloudAgentInput',
			kind: 'type',
			definition: `type LaunchCursorCloudAgentInput = {
	prompt: string
	repository: RepositoryTarget
	mode?: LaunchMode
	metadata?: Record<string, string>
	createdAt?: Date
}`,
		},
		{
			name: 'RepositoryTarget',
			kind: 'interface',
			definition: `interface RepositoryTarget {
	owner: string
	repo: string
}`,
		},
		{
			name: 'LaunchMode',
			kind: 'enum',
			definition: `enum LaunchMode {
	Background = 'background',
	Interactive = 'interactive',
}`,
		},
	])
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
})

test('buildPackageSearchProjection uses local declaration kind for exported const signatures', () => {
	const manifest = parseAuthoredPackageJson({
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

	const projection = buildPackageSearchProjection(manifest, {
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

	expect(projection.exports[0]?.functions).toEqual([
		{
			name: 'typed',
			description: null,
			typeDefinition: 'export declare const typed: (value: string) => string',
			referencedTypes: [],
		},
		{
			name: 'typedGeneric',
			description: null,
			typeDefinition:
				'export declare const typedGeneric: <T extends RenderedInput>(input: T) => string',
			referencedTypes: [
				{
					name: 'RenderedInput',
					kind: 'type',
					definition: `type RenderedInput = {
	value: string
}`,
				},
			],
		},
		{
			name: 'format',
			description: 'Runtime formatter.',
			typeDefinition: 'export function format(value: string): string',
			referencedTypes: [],
		},
		{
			name: 'genericFormat',
			description: null,
			typeDefinition: 'export function genericFormat(input: T): string',
			referencedTypes: [],
		},
	])
	expect(
		projection.exports[0]?.referencedTypes.map((type) => type.name),
	).toEqual(['RenderedInput'])
})

test('buildPackageSearchProjection skips referenced types that exceed the size budget', () => {
	const manifest = parseAuthoredPackageJson({
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

	const projection = buildPackageSearchProjection(manifest, {
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

	expect(projection.exports[0]?.referencedTypes).toEqual([
		{
			name: 'SmallInput',
			kind: 'type',
			definition: `type SmallInput = {
	value: string
}`,
		},
	])
})

test('parseAuthoredPackageJson rejects retriever definitions with no scopes', () => {
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

test('parseAuthoredPackageJson accepts email event subscriptions', () => {
	const manifest = parseAuthoredPackageJson({
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

	const projection = buildPackageSearchProjection(manifest)

	expect(projection.subscriptions).toEqual([
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

test('buildPackageSearchDocument includes exported APIs and package discovery surfaces', () => {
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/automation-hub',
			exports: {
				'.': {
					import: './src/index.ts',
					types: './src/index.d.ts',
				},
				'./run-event': './src/run-event.ts',
				'./search-notes': './src/search-notes.ts',
			},
			kody: {
				id: 'automation-hub',
				description: 'Automation package with retrievers and subscriptions',
				retrievers: {
					'notes-search': {
						export: './search-notes',
						name: 'Personal notes',
						description: 'Searches saved notes and snippets.',
						scopes: ['context', 'search'],
					},
				},
				subscriptions: {
					'email.message.received': {
						handler: './src/handle-received-email.ts',
						description: 'Notify on accepted inbound email',
					},
					'email.message.quarantined': {
						handler: './src/handle-quarantined-email.ts',
					},
				},
			},
		}),
		manifestPath: 'package.json',
	})
	const projection = buildPackageSearchProjection(manifest, {
		'src/index.d.ts': `/**
 * Look up the forecast for a city.
 */
export declare function forecast(city: string): Promise<string>
`,
	})
	const document = buildPackageSearchDocument(projection)
	const [retriever] = projection.retrievers

	expect(document).toContain('package automation-hub')
	expect(document).toContain(`retriever:${retriever?.key}`)
	expect(document).not.toContain('workflow:')
	expect(document).toContain('subscription:email.message.received')
	expect(document).toContain('subscription:email.message.quarantined')
	expect(document).toContain('. src/index.ts src/index.d.ts')
	expect(document).toContain('forecast')
	expect(document).toContain('Look up the forecast for a city.')
})
