import {
	TEST_OIDC_SIGNING_KEY_ID,
	TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} from '#worker/oidc/test-signing-key.ts'

/** Required `EnvSchema` string fields for node tests that call `getEnv`. */
export const testOidcSigningEnv = {
	OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
	OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} as const
