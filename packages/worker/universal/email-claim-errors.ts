/**
 * Structured signup/OAuth contract when the address is still claimed by an
 * existing account whose *current* login email is different. Copy must not
 * leak that account's current email.
 */
export const formerEmailClaimedSignupCode = 'former_email_claimed'

export const formerEmailClaimedSignupMessage =
	'This email is linked to an existing Kody account. Sign in with the email that account uses now — including a different Google mailbox — or release this address from Account settings → Former addresses on that account.'
