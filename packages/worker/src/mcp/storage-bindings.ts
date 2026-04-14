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
		return storageContext?.appId?.trim()
			? storageContext.appId
			: storageContext?.storageId?.trim()
				? storageContext.storageId
				: null
	}
	if (scope === 'session') {
		return storageContext?.sessionId?.trim() ? storageContext.sessionId : null
	}
	return null
}
