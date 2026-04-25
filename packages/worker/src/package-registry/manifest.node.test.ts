import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from './manifest.ts'

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
