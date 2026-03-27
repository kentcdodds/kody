import { expect, test } from 'vitest'
import {
	createCapabilitySecretAccessDeniedMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import { formatExecutionOutput, getExecutionErrorDetails } from './executor.ts'

test('getExecutionErrorDetails returns concrete guidance for capability access denial', () => {
	const error = new Error(
		createCapabilitySecretAccessDeniedMessage(
			'cloudflareToken',
			'cloudflare_rest',
		),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'secret_capability_access_required',
		message:
			'Secret "cloudflareToken" is not allowed for capability "cloudflare_rest". If this capability should be able to use the secret, ask the user whether to add "cloudflare_rest" to the secret\'s allowed capabilities in the account secrets UI, then retry after they approve that policy change.',
		nextStep:
			"Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
		secretNames: ['cloudflareToken'],
		capabilityName: 'cloudflare_rest',
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})
})

test('formatExecutionOutput includes capability access next step', () => {
	const result = {
		error: new Error(
			createCapabilitySecretAccessDeniedMessage(
				'cloudflareToken',
				'cloudflare_rest',
			),
		),
	} as const

	expect(formatExecutionOutput(result)).toContain(
		"Next step: Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
	)
})

test('formatExecutionOutput keeps missing secret guidance intact', () => {
	const result = {
		error: new Error(createMissingSecretMessage('missingToken')),
	} as const

	expect(formatExecutionOutput(result)).toContain(
		'Open a generated UI so the user can provide and save this secret',
	)
})
