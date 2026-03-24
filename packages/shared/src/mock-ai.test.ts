import { expect, test } from 'bun:test'
import { parseMockToolCommand } from './mock-ai.ts'

test('parseMockToolCommand returns null for non-tool messages', () => {
	expect(parseMockToolCommand('help')).toBeNull()
})

test('parseMockToolCommand parses basic scalar values', () => {
	expect(
		parseMockToolCommand('tool:open_generated_ui;code=<main>hello</main>'),
	).toEqual({
		toolName: 'open_generated_ui',
		input: {
			code: '<main>hello</main>',
		},
	})
})

test('parseMockToolCommand parses booleans and null', () => {
	expect(
		parseMockToolCommand('tool:example;flag=true;missing=null;label=test'),
	).toEqual({
		toolName: 'example',
		input: {
			flag: true,
			missing: null,
			label: 'test',
		},
	})
})
