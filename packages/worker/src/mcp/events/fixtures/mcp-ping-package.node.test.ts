import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	listPackageEmittedEvents,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'

const fixturePath = fileURLToPath(
	new URL('./mcp-ping-package.json', import.meta.url),
)

test('mcp-ping fixture opts one topic into MCP and keeps the internal topic off', () => {
	const manifest = parseAuthoredPackageJson({
		content: readFileSync(fixturePath, 'utf8'),
	})
	expect(manifest.kody.emits).toEqual({
		'@kentcdodds/mcp-ping.ready': expect.objectContaining({ mcp: true }),
		'@kentcdodds/mcp-ping.internal': expect.objectContaining({ mcp: false }),
	})
	const emitted = listPackageEmittedEvents(manifest)
	expect(emitted.map((event) => event.topic)).toEqual([
		'@kentcdodds/mcp-ping.internal',
		'@kentcdodds/mcp-ping.ready',
	])
	expect(emitted.filter((event) => event.mcp === true)).toEqual([
		{
			topic: '@kentcdodds/mcp-ping.ready',
			description: 'A ping was requested for an MCP Events subscriber.',
			payloadSchema: {
				type: 'object',
				properties: {
					message: { type: 'string', minLength: 1 },
				},
				required: ['message'],
				additionalProperties: false,
			},
			mcp: true,
		},
	])
})
