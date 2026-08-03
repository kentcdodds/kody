/**
 * Lightweight email ownership constants.
 *
 * Kept free of system-email / service imports so Mailbox and the dedicated
 * system-email graph can skip the reserved operator inbox without cycles.
 */

/** Reserved owner id for the platform operator inbox (stays in D1 only). */
export const systemEmailOwnerId = 'system:email'

export function isSystemEmailOwner(ownerId: string): boolean {
	return ownerId === systemEmailOwnerId
}
