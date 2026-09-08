import { expect, test } from 'vitest'
import {
	addReferralStandardCreditDuration,
	laterIsoTimestamp,
	normalizeEmailForReferralFraud,
	normalizeReferralCode,
	parseReferralCode,
	referralSharePath,
	resolveEffectivePlanWithStandardOverlays,
	unixSecondsToIso,
} from './referral-program.ts'

const now = new Date('2026-09-07T12:00:00.000Z')

test('referral codes, share links, stacking, overlays, and fraud email collapse', () => {
	expect(normalizeReferralCode(' KentCDodds ')).toBe('kentcdodds')
	expect(normalizeReferralCode('ab')).toBeNull()
	expect(normalizeReferralCode('not valid')).toBeNull()
	expect(
		parseReferralCode({ searchParams: new URLSearchParams('ref=Ada') }),
	).toBe('ada')
	expect(
		parseReferralCode({
			body: { referralCode: 'ada', ref: 'ignored-when-first-wins' },
		}),
	).toBe('ada')
	expect(
		parseReferralCode({ searchParams: new URLSearchParams('ref=x') }),
	).toBe(null)
	expect(referralSharePath('KentCDodds')).toBe('/signup?ref=kentcdodds')
	expect(referralSharePath('x')).toBe('/signup')

	expect(addReferralStandardCreditDuration({ now }).toISOString()).toBe(
		'2026-10-07T12:00:00.000Z',
	)
	expect(
		addReferralStandardCreditDuration({
			now,
			currentExpiresAt: '2026-11-01T00:00:00.000Z',
		}).toISOString(),
	).toBe('2026-12-01T00:00:00.000Z')
	expect(
		addReferralStandardCreditDuration({
			now,
			currentExpiresAt: '2026-08-01T00:00:00.000Z',
			paidPeriodEndAt: '2026-10-01T00:00:00.000Z',
		}).toISOString(),
	).toBe('2026-10-31T00:00:00.000Z')
	expect(
		addReferralStandardCreditDuration({
			now,
			currentExpiresAt: '2026-12-01T00:00:00.000Z',
			paidPeriodEndAt: '2026-10-01T00:00:00.000Z',
		}).toISOString(),
	).toBe('2026-12-31T00:00:00.000Z')

	expect(
		laterIsoTimestamp(
			null,
			'2026-01-01T00:00:00.000Z',
			'2026-02-01T00:00:00.000Z',
		),
	).toBe('2026-02-01T00:00:00.000Z')
	expect(laterIsoTimestamp('not-a-date', null)).toBeNull()

	expect(
		resolveEffectivePlanWithStandardOverlays(
			'free',
			null,
			'2026-10-01T00:00:00.000Z',
			now,
		),
	).toBe('standard')
	expect(
		resolveEffectivePlanWithStandardOverlays(
			'free',
			'pro',
			'2026-10-01T00:00:00.000Z',
			now,
		),
	).toBe('pro')
	expect(
		resolveEffectivePlanWithStandardOverlays(
			'free',
			null,
			'2026-08-01T00:00:00.000Z',
			now,
		),
	).toBe('free')

	expect(normalizeEmailForReferralFraud('Ada+1@Gmail.com')).toBe(
		'ada@gmail.com',
	)
	expect(normalizeEmailForReferralFraud('a.da@googlemail.com')).toBe(
		'ada@gmail.com',
	)
	expect(normalizeEmailForReferralFraud('ada+work@example.com')).toBe(
		'ada@example.com',
	)
	expect(unixSecondsToIso(1_788_782_400)).toBe('2026-09-07T12:00:00.000Z')
	expect(unixSecondsToIso('nope')).toBeNull()
})
