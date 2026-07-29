import {
	storageScopeValues,
	type StorageContext,
	type StorageScope,
} from './storage.ts'

export const defaultStorageLookupOrder = [
	...storageScopeValues,
] as Array<StorageScope>

export function resolveStorageScopeOrder(
	storageContext: StorageContext | null,
) {
	return defaultStorageLookupOrder.filter(
		(scope) => getStorageBindingKey(scope, storageContext) != null,
	)
}

export function getStorageBindingKey(
	scope: StorageScope,
	storageContext: StorageContext | null,
) {
	if (scope === 'user') return ''
	if (scope === 'app') {
		const appId = storageContext?.appId?.trim()
		return appId || null
	}
	if (scope === 'session') {
		const sessionId = storageContext?.sessionId?.trim()
		return sessionId || null
	}
	return null
}
