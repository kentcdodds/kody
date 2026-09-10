import { expect, test } from 'vitest'
import { faqRouteLoader } from './faq.tsx'
import { pricingRouteLoader } from './pricing.tsx'
import { publicSignupPrimaryCta } from '#universal/public-signup-copy.ts'
import { routes } from '#universal/routes.ts'

test('public signup CTA always points at create-account', () => {
	expect(publicSignupPrimaryCta().href).toBe(routes.signup.href())
})

test('FAQ and pricing loaders do not fetch signup gating', async () => {
	expect(await faqRouteLoader()).toEqual({})
	expect(await pricingRouteLoader()).toEqual({})
})
