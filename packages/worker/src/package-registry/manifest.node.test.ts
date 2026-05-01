import { expect, test } from 'vitest'
import {
	buildPackageSearchDocument,
	buildPackageSearchProjection,
	parseAuthoredPackageJson,
} from './manifest.ts'

test('parseAuthoredPackageJson accepts package names whose leaf matches kody.id', () => {
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
	})

	expect(manifest.name).toBe('@kentcdodds/cursor-cloud-agents')
	expect(manifest.kody.id).toBe('cursor-cloud-agents')
})

test('parseAuthoredPackageJson rejects package names whose leaf does not match kody.id', () => {
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
})

test('parseAuthoredPackageJson rejects unscoped package names', () => {
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
	expect(buildPackageSearchDocument(projection)).toContain(
		'retriever:notes-search',
	)
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
				},
				{
					name: 'celsiusToFahrenheit',
					description: 'Convert Celsius to Fahrenheit.',
					typeDefinition:
						'export declare const celsiusToFahrenheit: (value: number) => number',
				},
			],
		}),
	])
	const document = buildPackageSearchDocument(projection)
	expect(document).toContain(
		'export declare function forecast(city: string): Promise<string>',
	)
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
		'src/index.ts': `/**
 * Package version metadata.
 */
export declare const VERSION: string

export declare const typed: (value: string) => string

/**
 * Runtime formatter.
 */
export const format = (value: string): string => value.trim()
`,
	})

	expect(projection.exports[0]?.functions).toEqual([
		{
			name: 'typed',
			description: null,
			typeDefinition: 'export declare const typed: (value: string) => string',
		},
		{
			name: 'format',
			description: 'Runtime formatter.',
			typeDefinition: 'export function format(value: string): string',
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
	expect(buildPackageSearchDocument(projection)).toContain(
		'subscription:email.message.received',
	)
	expect(buildPackageSearchDocument(projection)).toContain(
		'subscription:email.message.quarantined',
	)
})
