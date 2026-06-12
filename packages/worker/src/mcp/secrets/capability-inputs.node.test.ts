import { expect, test } from 'vitest'
import {
	resolveCapabilityInputSecrets,
	secretInputSchemaFlag,
} from './capability-inputs.ts'

test('resolveCapabilityInputSecrets replaces annotated secret placeholders in nested values', async () => {
	const flatResult = await resolveCapabilityInputSecrets({
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

	expect(flatResult).toEqual({
		username: 'wireless-user',
		password: 'Bearer wireless-pass',
		label: '{{secret:displayName}}',
	})

	const nestedResult = await resolveCapabilityInputSecrets({
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

	expect(nestedResult).toEqual({
		processors: [
			{ password: 'firstPassword-value' },
			{ password: 'secondPassword-value' },
		],
	})
})
