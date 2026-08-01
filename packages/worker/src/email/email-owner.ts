/**
 * Lightweight email ownership constants.
 *
 * Kept free of system-email / service imports so dual-write helpers
 * (`mailbox-mirror`) can skip the reserved operator inbox without creating
 * import cycles (service → mailbox-mirror → … → service).
 */

/** Reserved owner id for the platform operator inbox (stays in D1 only). */
export const systemEmailOwnerId = 'system:email'

export function isSystemEmailOwner(ownerId: string): boolean {
	return ownerId === systemEmailOwnerId
}
