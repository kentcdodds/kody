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
	const hrefs: Array<[string, boolean]> = [
		['/account/secrets/approve', true],
		[
			'/account/secrets/approve?package_id=pkg-notes&names=openai-api-key',
			true,
		],
		[
			'/account/secrets/user/openai-api-key?package_id=pkg-notes&package=notes',
			true,
		],
		['/account/secrets/user/openai-api-key', false],
		['/account/secrets', false],
		[
			'/account/secrets/new?package_id=pkg-notes&package=notes&name=openai-api-key',
			false,
		],
		['/account/secrets?package_id=pkg-notes', false],
		[
			'/account/secrets/package/pkg-notes/signingSecret?package_id=pkg-notes',
			false,
		],
	]
	expect(
		hrefs.filter(([href, want]) => isPackageApprovalHref(href) !== want),
	).toEqual([])

	const granted = (
		secrets: Array<typeof secret>,
		names: Array<string> = approval.names,
	) =>
		isPackageSecretApprovalAlreadyGranted({
			secrets,
			approval: { ...approval, names },
		})
	expect(granted([{ ...secret, allowedPackages: [] }])).toBe(false)
	expect(granted([secret])).toBe(true)
	expect(granted([])).toBe(false)
	expect(granted([secret], ['openai-api-key', 'missing'])).toBe(false)

	const views = [
		[null, false, { fullyAllowed: false, showBackToSecrets: false }],
		['approve', false, { fullyAllowed: true, showBackToSecrets: true }],
		[null, true, { fullyAllowed: true, showBackToSecrets: true }],
		['reject', false, { fullyAllowed: false, showBackToSecrets: true }],
	] as const
	expect(
		views.map(([completed, alreadyGranted]) => [
			completed,
			alreadyGranted,
			readPackageSecretApprovalView({ completed, alreadyGranted }),
		]),
	).toEqual(views)
})
