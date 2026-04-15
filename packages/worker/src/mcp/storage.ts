export const storageScopeValues = ['session', 'app', 'user'] as const

export type StorageScope = (typeof storageScopeValues)[number]

export type StorageContext = {
	sessionId: string | null
	appId: string | null
	storageId?: string | null
}
