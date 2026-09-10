import { expect, test } from 'vitest'
import {
	isPackageApprovalHref,
	isPackageSecretApprovalAlreadyGranted,
	readPackageSecretApprovalView,
} from './account-secrets-approval.tsx'

const secret = {
	id: 'user:openai-api-key',
	name: 'openai-api-key',
	scope: 'user' as const,
	description: '',
	packageId: null,
	packageTitle: null,
	allowedHosts: [],
	allowedPackages: ['pkg-notes'],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	expiresAt: null,
	ttlMs: null,
}

const approval = {
	name: 'openai-api-key',
	names: ['openai-api-key'],
	scope: 'user' as const,
	requestedHost: '',
	requestedHosts: [],
	rejectedHosts: [],
	requestedPackageId: 'pkg-notes',
	currentAllowedHosts: [],
	currentAllowedPackages: [],
}

test('package secret approval hrefs and already-granted checks match host-approval spirit', () => {
	expect(isPackageApprovalHref('/account/secrets/approve')).toBe(true)
	expect(
		isPackageApprovalHref(
			'/account/secrets/approve?package_id=pkg-notes&names=openai-api-key',
		),
	).toBe(true)
	expect(
		isPackageApprovalHref(
			'/account/secrets/user/openai-api-key?package_id=pkg-notes&package=notes',
		),
	).toBe(true)
	expect(isPackageApprovalHref('/account/secrets/user/openai-api-key')).toBe(
		false,
	)
	expect(isPackageApprovalHref('/account/secrets')).toBe(false)
	expect(
		isPackageApprovalHref(
			'/account/secrets/new?package_id=pkg-notes&package=notes&name=openai-api-key',
		),
	).toBe(false)
	expect(isPackageApprovalHref('/account/secrets?package_id=pkg-notes')).toBe(
		false,
	)
	expect(
		isPackageApprovalHref(
			'/account/secrets/package/pkg-notes/signingSecret?package_id=pkg-notes',
		),
	).toBe(false)

	expect(
		isPackageSecretApprovalAlreadyGranted({
			secrets: [{ ...secret, allowedPackages: [] }],
			approval,
		}),
	).toBe(false)
	expect(
		isPackageSecretApprovalAlreadyGranted({
			secrets: [secret],
			approval,
		}),
	).toBe(true)
	expect(
		isPackageSecretApprovalAlreadyGranted({
			secrets: [],
			approval,
		}),
	).toBe(false)
	expect(
		isPackageSecretApprovalAlreadyGranted({
			secrets: [secret],
			approval: { ...approval, names: ['openai-api-key', 'missing'] },
		}),
	).toBe(false)

	expect(
		readPackageSecretApprovalView({
			completed: null,
			alreadyGranted: false,
		}),
	).toEqual({ fullyAllowed: false, showBackToSecrets: false })
	expect(
		readPackageSecretApprovalView({
			completed: 'approve',
			alreadyGranted: false,
		}),
	).toEqual({ fullyAllowed: true, showBackToSecrets: true })
	expect(
		readPackageSecretApprovalView({
			completed: null,
			alreadyGranted: true,
		}),
	).toEqual({ fullyAllowed: true, showBackToSecrets: true })
	expect(
		readPackageSecretApprovalView({
			completed: 'reject',
			alreadyGranted: false,
		}),
	).toEqual({ fullyAllowed: false, showBackToSecrets: true })
})
