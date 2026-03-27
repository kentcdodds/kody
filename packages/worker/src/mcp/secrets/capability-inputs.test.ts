import { expect, test } from 'vitest'
import {
	resolveCapabilityInputSecrets,
	secretInputSchemaFlag,
} from './capability-inputs.ts'

test('resolveCapabilityInputSecrets replaces placeholders for annotated fields', async () => {
	const result = await resolveCapabilityInputSecrets({
		schema: {
			type: 'object',
			properties: {
				username: {
					type: 'string',
					[secretInputSchemaFlag]: true,
				},
				password: {
					type: 'string',
					[secretInputSchemaFlag]: true,
				},
				label: {
					type: 'string',
				},
			},
		},
		value: {
			username: '{{secret:lutronUsername|scope=user}}',
			password: 'Bearer {{secret:lutronPassword}}',
			label: '{{secret:displayName}}',
		},
		resolveSecretValue: async (secret) => {
			if (secret.name === 'lutronUsername') return 'wireless-user'
			if (secret.name === 'lutronPassword') return 'wireless-pass'
			throw new Error(`Unexpected secret ${secret.name}`)
		},
	})

	expect(result).toEqual({
		username: 'wireless-user',
		password: 'Bearer wireless-pass',
		label: '{{secret:displayName}}',
	})
})

test('resolveCapabilityInputSecrets walks nested arrays and objects', async () => {
	const result = await resolveCapabilityInputSecrets({
		schema: {
			type: 'object',
			properties: {
				processors: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							password: {
								type: 'string',
								[secretInputSchemaFlag]: true,
							},
						},
					},
				},
			},
		},
		value: {
			processors: [
				{ password: '{{secret:firstPassword}}' },
				{ password: '{{secret:secondPassword}}' },
			],
		},
		resolveSecretValue: async (secret) => `${secret.name}-value`,
	})

	expect(result).toEqual({
		processors: [
			{ password: 'firstPassword-value' },
			{ password: 'secondPassword-value' },
		],
	})
})
