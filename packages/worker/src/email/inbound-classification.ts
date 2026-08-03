import { normalizeEmailAddress } from './address.ts'
import { resolveInboundEmailAuthVerdict } from './auth-verdict.ts'
import { evaluateEmailSenderRules } from './sender-rules.ts'
import { type EmailClassification } from './types.ts'

export async function resolveInboundEmailClassification(input: {
	db: D1Database
	userId: string
	envelopeFrom: string
	authResults: string | null
}): Promise<{
	classification: EmailClassification
	classificationReason: string | null
}> {
	const senderAddress = normalizeEmailAddress(input.envelopeFrom)
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
				return { classification: 'accepted', classificationReason: null }
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

	const verdict = resolveInboundEmailAuthVerdict(input.authResults)
	if (verdict.suspect) {
		return {
			classification: 'quarantined',
			classificationReason: verdict.reason,
		}
	}
	return { classification: 'accepted', classificationReason: null }
}
