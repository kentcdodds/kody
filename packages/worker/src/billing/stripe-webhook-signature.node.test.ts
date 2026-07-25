import { expect, test } from 'vitest'
import {
	buildStripeWebhookSignatureHeader,
	computeStripeWebhookSignature,
	verifyStripeWebhookSignature,
} from './stripe-webhook-signature.ts'

const fixtureSecret = 'whsec_test_fixture_secret'
const fixtureBody =
	'{"id":"evt_test_fixture","object":"event","type":"checkout.session.completed","data":{"object":{"id":"cs_test"}}}'
const fixtureTimestamp = 1_700_000_000
/** HMAC-SHA256 hex of `${t}.${rawBody}` keyed by UTF-8(whsec_...) via Node crypto. */
const fixtureSignature =
	'850a8305dd40d37b2ad74f83d4a32d429fe9a017a6db9ac082e7ea2c3b430140'

test('computeStripeWebhookSignature matches known HMAC fixture', async () => {
	const signature = await computeStripeWebhookSignature({
		secret: fixtureSecret,
		timestamp: fixtureTimestamp,
		rawBody: fixtureBody,
	})
	expect(signature).toBe(fixtureSignature)
})

test('verifyStripeWebhookSignature accepts valid headers and rejects bad ones', async () => {
	const header = `t=${fixtureTimestamp},v1=${fixtureSignature}`

	await expect(
		verifyStripeWebhookSignature({
			secret: fixtureSecret,
			signatureHeader: header,
			rawBody: fixtureBody,
			nowSeconds: fixtureTimestamp,
		}),
	).resolves.toEqual({ timestamp: fixtureTimestamp })

	const built = await buildStripeWebhookSignatureHeader({
		secret: fixtureSecret,
		rawBody: fixtureBody,
		timestamp: fixtureTimestamp,
	})
	expect(built).toBe(header)

	await expect(
		verifyStripeWebhookSignature({
			secret: fixtureSecret,
			signatureHeader: null,
			rawBody: fixtureBody,
			nowSeconds: fixtureTimestamp,
		}),
	).rejects.toMatchObject({
		name: 'StripeWebhookSignatureError',
		code: 'missing_header',
	})

	await expect(
		verifyStripeWebhookSignature({
			secret: fixtureSecret,
			signatureHeader: `t=${fixtureTimestamp},v1=${'0'.repeat(64)}`,
			rawBody: fixtureBody,
			nowSeconds: fixtureTimestamp,
		}),
	).rejects.toMatchObject({ code: 'signature_mismatch' })

	await expect(
		verifyStripeWebhookSignature({
			secret: fixtureSecret,
			signatureHeader: header,
			rawBody: fixtureBody.replace('evt_test_fixture', 'evt_tampered'),
			nowSeconds: fixtureTimestamp,
		}),
	).rejects.toMatchObject({ code: 'signature_mismatch' })

	await expect(
		verifyStripeWebhookSignature({
			secret: fixtureSecret,
			signatureHeader: header,
			rawBody: fixtureBody,
			toleranceSeconds: 300,
			nowSeconds: fixtureTimestamp + 301,
		}),
	).rejects.toMatchObject({ code: 'timestamp_tolerance' })

	await expect(
		verifyStripeWebhookSignature({
			secret: fixtureSecret,
			signatureHeader: `t=${fixtureTimestamp},v0=deadbeef`,
			rawBody: fixtureBody,
			nowSeconds: fixtureTimestamp,
		}),
	).rejects.toMatchObject({ code: 'no_v1_signatures' })
})
