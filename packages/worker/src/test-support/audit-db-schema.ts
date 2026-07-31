import {
	applyD1Migrations,
	type D1Migration,
	env,
} from 'cloudflare:test'

const testEnv = env as Env & {
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

await applyD1Migrations(env.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
