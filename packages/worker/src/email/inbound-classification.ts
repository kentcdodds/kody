import { normalizeEmailAddress } from './address.ts'
import { resolveInboundEmailAuthVerdict } from './auth-verdict.ts'
import { authenticatesFromAddress } from './inbound-sender.ts'
import { evaluateEmailSenderRules } from './sender-rules.ts'
import { type EmailClassification } from './types.ts'

export async function resolveInboundEmailClassification(input: {
	db: D1Database
	userId: string
	/** RFC5322 From; sender rules match this address, not the envelope. */
	fromAddress: string | null
	envelopeFrom: string
	authResults: string | null
}): Promise<{
	classification: EmailClassification
	classificationReason: string | null
}> {
	// Authentication is decided before sender rules so an allow address/domain
	// rule cannot accept spoofed (auth-failed) mail.
	const verdict = resolveInboundEmailAuthVerdict(input.authResults)

	const senderAddress = input.fromAddress
		? normalizeEmailAddress(input.fromAddress)
		: null
	const ruleMatch = senderAddress
		? await evaluateEmailSenderRules({
				db: input.db,
				userId: input.userId,
				senderAddress,
			})
		: null

	if (ruleMatch) {
		switch (ruleMatch.effect) {
			case 'allow':
				if (
					senderAddress &&
					authenticatesFromAddress({
						verdict,
						fromAddress: senderAddress,
						envelopeFrom: input.envelopeFrom,
					})
				) {
					return { classification: 'accepted', classificationReason: null }
				}
				return {
					classification: 'quarantined',
					classificationReason: verdict.suspect
						? verdict.reason
						: 'Sender matched allow rule but From did not authenticate.',
				}
			case 'block':
				return {
					classification: 'quarantined',
					classificationReason: `Sender matched block rule ${ruleMatch.rule.value}.`,
				}
			case 'quarantine':
				return {
					classification: 'quarantined',
					classificationReason: `Sender matched quarantine rule ${ruleMatch.rule.value}.`,
				}
			default: {
				const exhaustive: never = ruleMatch.effect
				throw new Error(`Unsupported sender rule effect: ${String(exhaustive)}`)
			}
		}
	}

	if (verdict.suspect) {
		return {
			classification: 'quarantined',
			classificationReason: verdict.reason,
		}
	}
	return { classification: 'accepted', classificationReason: null }
}
