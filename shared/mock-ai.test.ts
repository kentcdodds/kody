import { expect, test } from 'bun:test'
import { parseMockToolCommand } from './mock-ai.ts'

test('parseMockToolCommand returns null for non-tool messages', () => {
	expect(parseMockToolCommand('help')).toBeNull()
})

test('parseMockToolCommand parses basic scalar values', () => {
	expect(
		parseMockToolCommand('tool:do_math;left=1;right=2;operator=+'),
	).toEqual({
		toolName: 'do_math',
		input: {
			left: 1,
			right: 2,
			operator: '+',
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
