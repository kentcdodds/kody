import { expect, test } from 'vitest'
import {
	grantedSecretAuthorityPackageIdSet,
	readSecretAuthorityHeader,
	resolveSecretAuthorityPackageId,
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
	secretAuthorityArgName,
	secretAuthorityHeaderName,
	takeSecretAuthorityFromCapabilityArgs,
	resolveCallerSecretAuthority,
} from './secret-authority.ts'

test('secret authority prefers a granted stamp id and ignores unrelated forgeries', () => {
	const granted = new Set(['pkg-a', 'pkg-b'])
	expect(
		resolveSecretAuthorityPackageId({
			requestedPackageId: 'pkg-a',
			grantedPackageIds: granted,
			runPackageId: 'pkg-b',
		}),
	).toBe('pkg-a')
	expect(
		resolveSecretAuthorityPackageId({
			requestedPackageId: 'pkg-unrelated',
			grantedPackageIds: granted,
			runPackageId: 'pkg-b',
		}),
	).toBe('pkg-b')
	expect(
		resolveSecretAuthorityPackageId({
			requestedPackageId: null,
			grantedPackageIds: granted,
			runPackageId: null,
		}),
	).toBeNull()
	// No grant set (MCP / unit tests): an explicit requested id is honored.
	expect(
		resolveSecretAuthorityPackageId({
			requestedPackageId: 'pkg-a',
			grantedPackageIds: null,
			runPackageId: 'pkg-b',
		}),
	).toBe('pkg-a')
})

test('fetch header and capability args carry stamp identity and drop forgeries', () => {
	const granted = new Set(['pkg-a'])
	const headers = new Headers({
		[secretAuthorityHeaderName]: 'pkg-a',
	})
	expect(readSecretAuthorityHeader(headers, granted)).toBe('pkg-a')
	headers.set(secretAuthorityHeaderName, 'pkg-unrelated')
	expect(readSecretAuthorityHeader(headers, granted)).toBeNull()

	const taken = takeSecretAuthorityFromCapabilityArgs([
		{ name: 'token', [secretAuthorityArgName]: 'pkg-a' },
	])
	expect(taken.requestedPackageId).toBe('pkg-a')
	expect(taken.args[0]).toEqual({ name: 'token' })
	expect(
		takeSecretAuthorityFromCapabilityArgs([{ name: 'token' }])
			.requestedPackageId,
	).toBeNull()
})

test('caller secret authority uses the host ALS current stamp when granted', () => {
	const granted = new Set(['pkg-a', 'pkg-b'])
	const fromRun = resolveCallerSecretAuthority({
		storageContext: { sessionId: null, appId: null, packageId: 'pkg-b' },
	})
	expect(fromRun.authorityPackageId).toBe('pkg-b')

	runWithSecretAuthorityScope(granted, () => {
		runWithCurrentSecretAuthority('pkg-a', () => {
			const stamped = resolveCallerSecretAuthority({
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: 'pkg-b',
				},
			})
			expect(stamped.authorityPackageId).toBe('pkg-a')
			expect(stamped.storageContext.packageId).toBe('pkg-a')
		})
		runWithCurrentSecretAuthority('pkg-unrelated', () => {
			const forged = resolveCallerSecretAuthority({
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: 'pkg-b',
				},
			})
			expect(forged.authorityPackageId).toBe('pkg-b')
		})
	})
	expect(grantedSecretAuthorityPackageIdSet(['pkg-a'])?.has('pkg-a')).toBe(true)
	// An installed empty set is fail-closed: execute with no provenance
	// must not treat a forged stamp as "no grant set installed".
	expect(grantedSecretAuthorityPackageIdSet([])?.size).toBe(0)
	expect(grantedSecretAuthorityPackageIdSet(null)).toBeNull()
	expect(
		resolveSecretAuthorityPackageId({
			requestedPackageId: 'pkg-forged',
			grantedPackageIds: new Set(),
			runPackageId: null,
		}),
	).toBeNull()
})
