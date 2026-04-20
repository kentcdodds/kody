import { type McpStorageContext } from '@kody-internal/shared/chat.ts'
import { type StorageContext } from '#mcp/storage.ts'

type PackageStorageContext = StorageContext &
	Required<Pick<McpStorageContext, 'sessionId' | 'appId' | 'storageId'>>

type CreatePackageStorageContextInput = {
	packageId: string
	storageId?: string | null
	sessionId?: string | null
}

export function createPackageStorageContext(
	input: CreatePackageStorageContextInput,
): PackageStorageContext {
	const packageId = input.packageId.trim()
	if (!packageId) {
		throw new Error('Package storage context requires a package id.')
	}
	return {
		sessionId: input.sessionId ?? null,
		appId: packageId,
		storageId: input.storageId?.trim() || packageId,
	}
}
