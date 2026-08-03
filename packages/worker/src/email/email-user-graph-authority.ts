import { isSystemEmailOwner } from './email-owner.ts'

/**
 * Step 5a prerequisite contract only.
 *
 * No production write path consumes these assertions in this slice, so this
 * module does not yet protect live traffic. The step 5a write-cutover must route
 * every USER graph mutation through this contract when it removes shared-D1
 * writes.
 */

export const emailUserGraphAuthority = 'mailbox' as const
export const systemEmailGraphAuthority = 'dedicated-system-d1' as const

export type EmailGraphAuthority =
	| typeof emailUserGraphAuthority
	| typeof systemEmailGraphAuthority

export function emailGraphAuthorityForOwner(
	ownerId: string,
): EmailGraphAuthority {
	return isSystemEmailOwner(ownerId)
		? systemEmailGraphAuthority
		: emailUserGraphAuthority
}

export function assertEmailGraphAuthority(input: {
	ownerId: string
	authority: EmailGraphAuthority
}): void {
	const expected = emailGraphAuthorityForOwner(input.ownerId)
	if (input.authority !== expected) {
		throw new Error(
			`Email graph owner ${input.ownerId} requires ${expected} authority, not ${input.authority}.`,
		)
	}
}

export function assertUserEmailGraphOwner(ownerId: string): void {
	if (isSystemEmailOwner(ownerId)) {
		throw new Error(
			'The reserved system email owner requires dedicated D1 graph authority.',
		)
	}
}

export function assertSystemEmailGraphOwner(ownerId: string): void {
	if (!isSystemEmailOwner(ownerId)) {
		throw new Error('USER email graph owners require Mailbox authority.')
	}
}
