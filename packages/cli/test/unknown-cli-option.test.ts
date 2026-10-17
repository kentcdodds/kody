import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	assertNoUnknownCliOptions,
	suggestKnownCliOption,
	unknownCliOptionError,
} from '../src/unknown-cli-option.js'

const known = ['code', 'file', 'local', 'invoke']

test('suggestKnownCliOption prefers a hyphen suffix over a shorter prefix', () => {
	assert.equal(suggestKnownCliOption('--code-file', known), '--file')
	assert.equal(suggestKnownCliOption('--file', known), '--file')
	assert.equal(suggestKnownCliOption('--fil', known), null)
})

test('unknownCliOptionError names the closest valid flag', () => {
	assert.match(
		unknownCliOptionError('--code-file', known).message,
		/Unknown option "--code-file"\. Did you mean --file\?/,
	)
	assert.match(
		unknownCliOptionError('--wat', known).message,
		/Unknown option "--wat"\. Run `kody --help` for usage\./,
	)
})

test('assertNoUnknownCliOptions ignores known options and positionals', () => {
	assert.doesNotThrow(() =>
		assertNoUnknownCliOptions(
			[
				{ kind: 'positional', rawName: 'execute' },
				{ kind: 'option', name: 'local', rawName: '--local' },
				{ kind: 'option', name: 'file', rawName: '--file' },
			],
			known,
		),
	)
	assert.throws(
		() =>
			assertNoUnknownCliOptions(
				[{ kind: 'option', name: 'code-file', rawName: '--code-file' }],
				known,
			),
		/Did you mean --file\?/,
	)
})

test('assertNoUnknownCliOptions rejects a flag consumed as a string option value', () => {
	assert.throws(
		() =>
			assertNoUnknownCliOptions(
				[
					{
						kind: 'option',
						name: 'file',
						rawName: '--file',
						value: '--code-file',
						inlineValue: false,
					},
				],
				known,
			),
		/Did you mean --file\?/,
	)
	assert.doesNotThrow(() =>
		assertNoUnknownCliOptions(
			[
				{
					kind: 'option',
					name: 'file',
					rawName: '--file',
					value: '--code-file',
					inlineValue: true,
				},
			],
			known,
		),
	)
})
