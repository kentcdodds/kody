import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { authorizeCapabilityStorageId } from './storage-access.ts'

const packageId = 'b2fda105-005a-4e2b-9f22-1513b6752da2'
const victimPackageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function createCallerContext(
	callerPackageId: string | null,
	boundStorageId?: string,
) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
		},
		storageContext: {
			sessionId: null,
			appId: callerPackageId,
			packageId: callerPackageId,
			storageId:
				boundStorageId ??
				(callerPackageId ? buildPackageStorageId(callerPackageId) : null),
		},
	})
}

function authorize(
	callerPackageId: string | null,
	storageId: string,
	boundStorageId?: string,
) {
	return authorizeCapabilityStorageId({
		callerContext: createCallerContext(callerPackageId, boundStorageId),
		capabilityName: 'storage_query',
		storageId,
	})
}

test('user-driven callers keep account-scoped storage ids', () => {
	expect(authorize(null, buildPackageStorageId(victimPackageId))).toBe(
		buildPackageStorageId(victimPackageId),
	)
	expect(authorize(null, ' exec:scratch-1 ')).toBe('exec:scratch-1')
	expect(() => authorize(null, '   ')).toThrow(McpCallerError)
})

test('package callers reach only buckets their package owns', () => {
	for (const storageId of [
		packageId,
		buildPackageStorageId(packageId),
		`${packageId}:facet:main`,
		`job:package-job:${packageId}:nightly`,
	]) {
		expect(authorize(packageId, storageId)).toBe(storageId)
	}

	for (const storageId of [
		buildPackageStorageId(victimPackageId),
		victimPackageId,
		`${victimPackageId}:facet:main`,
		`job:package-job:${victimPackageId}:nightly`,
		'job:ad-hoc-1',
		'exec:scratch-1',
		'session:abc',
	]) {
		expect(() => authorize(packageId, storageId)).toThrow(McpCallerError)
	}
})

test('a package caller keeps the bucket the host bound for its run', () => {
	const boundJobBucket = `job:${crypto.randomUUID()}`
	expect(authorize(packageId, boundJobBucket, boundJobBucket)).toBe(
		boundJobBucket,
	)
	expect(() =>
		authorize(packageId, `job:${crypto.randomUUID()}`, boundJobBucket),
	).toThrow(McpCallerError)
})

test('non-UUID package ids get no prefix reach into reserved namespaces', () => {
	expect(authorize('job', 'job')).toBe('job')
	expect(authorize('job', buildPackageStorageId('job'))).toBe('package:job')
	expect(() => authorize('job', 'job:ad-hoc-1')).toThrow(McpCallerError)
	expect(() => authorize('exec', 'exec:scratch-1')).toThrow(McpCallerError)
})

test('denial names the capability, package, and bucket', () => {
	expect(() =>
		authorize(packageId, buildPackageStorageId(victimPackageId)),
	).toThrow(
		new RegExp(
			`storage_query.+${buildPackageStorageId(victimPackageId)}.+${packageId}`,
		),
	)
})
