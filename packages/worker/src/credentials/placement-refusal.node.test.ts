import { expect, test } from 'vitest'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import {
	buildCredentialPlacementRefusedWebhookError,
	formatCredentialPlacementRefusalTag,
	readCredentialPlacementRefusal,
	readCredentialPlacementRefusalFromInvocationBody,
	stripCredentialPlacementRefusalTag,
} from './placement-refusal.ts'

test('a placement refusal round-trips its slot through the error message', () => {
	const error = new SecretPlacementError(
		'Secret "clerkReviewUserId" cannot be sent to host "example.com" over plain HTTP.',
		'clerkReviewUserId',
	)
	expect(error.message).toBe(
		'Secret "clerkReviewUserId" cannot be sent to host "example.com" over plain HTTP. (credential_placement_refused, slot "clerkReviewUserId")',
	)
	expect(error.code).toBe('credential_placement_refused')
	expect(readCredentialPlacementRefusal(`Error: ${error.message}`)).toEqual({
		slot: 'clerkReviewUserId',
	})
	expect(
		readCredentialPlacementRefusal(
			new SecretPlacementError('Vault secret is over plain HTTP.', null)
				.message,
		),
	).toEqual({ slot: null })
	expect(readCredentialPlacementRefusal('Secret "x" was not found.')).toBeNull()
})

test('a tag never carries a slot outside the name charset', () => {
	expect(formatCredentialPlacementRefusalTag('bad name")')).toBe(
		'(credential_placement_refused)',
	)
})

test('the invocation body reader finds the tag in error.message only', () => {
	expect(
		readCredentialPlacementRefusalFromInvocationBody({
			error: {
				message: 'boom (credential_placement_refused, slot "token")',
			},
		}),
	).toEqual({ slot: 'token' })
	expect(
		readCredentialPlacementRefusalFromInvocationBody({
			logs: ['(credential_placement_refused, slot "token")'],
		}),
	).toBeNull()
	expect(readCredentialPlacementRefusalFromInvocationBody(null)).toBeNull()
})

test('the webhook error names the code and slot and nothing else', () => {
	expect(buildCredentialPlacementRefusedWebhookError(null)).toEqual({
		code: 'credential_placement_refused',
		message:
			"The package tried to send a credential to a host the credential does not allow, over plain HTTP, or in the URL host, so Kody refused the request. The package owner or the credential's owner needs to fix it.",
	})
})

test('stripping the tag leaves a structured message parseable', () => {
	const message = new SecretPlacementError(
		'Secrets require host approval: {}',
		'token',
	).message
	expect(stripCredentialPlacementRefusalTag(message)).toBe(
		'Secrets require host approval: {}',
	)
	expect(stripCredentialPlacementRefusalTag('no tag here')).toBe('no tag here')
})
