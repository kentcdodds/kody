import { expect, test } from 'vitest'
import {
	checkDeployGuardrails,
	checkDurableObjectConfig,
	checkWorkflowSource,
	type DurableObjectBaseline,
	type DurableObjectDeletionAllowlist,
} from './check-deploy-guardrails.ts'

const configPath = 'packages/worker/wrangler.jsonc'
const baseline = {
	path: configPath,
	protected_migrations: [{ tag: 'v1', new_sqlite_classes: ['Mailbox'] }],
	protected_binding_sets: [
		{
			location: 'env.production.durable_objects',
			bindings: [{ name: 'MAILBOX', class_name: 'Mailbox' }],
		},
	],
} satisfies DurableObjectBaseline['configs'][number]

function createConfig(
	deletedClasses: Array<string> | undefined,
	deletionTag = 'v2',
) {
	return {
		migrations: [
			{ tag: 'v1', new_sqlite_classes: ['Mailbox'] },
			...(deletedClasses
				? [{ tag: deletionTag, deleted_classes: deletedClasses }]
				: []),
		],
		env: {
			production: {
				durable_objects: {
					bindings: [{ name: 'MAILBOX', class_name: 'Mailbox' }],
				},
			},
		},
	}
}

test('Durable Object guard rejects unreviewed deletion and accepts its exact allowlist entry', () => {
	const emptyAllowlist = {
		version: 1,
		deletions: [],
	} satisfies DurableObjectDeletionAllowlist
	const unreviewedErrors = checkDurableObjectConfig(
		configPath,
		createConfig(['Mailbox']),
		baseline,
		emptyAllowlist,
	)
	expect(unreviewedErrors).toEqual([
		expect.stringContaining(
			'destructive deletion v2 [Mailbox] is not an exact entry',
		),
	])

	const reviewedAllowlist = {
		version: 1,
		deletions: [{ config: configPath, tag: 'v2', classes: ['Mailbox'] }],
	} satisfies DurableObjectDeletionAllowlist
	expect(
		checkDurableObjectConfig(
			configPath,
			createConfig(['Mailbox']),
			baseline,
			reviewedAllowlist,
		),
	).toEqual([])

	expect(
		checkDurableObjectConfig(
			configPath,
			createConfig(['Mailbox', 'RunLog']),
			baseline,
			reviewedAllowlist,
		),
	).toEqual([expect.stringContaining('is not an exact entry')])
})

test('Durable Object guard protects migration tags and bound classes', () => {
	const allowlist = {
		version: 1,
		deletions: [],
	} satisfies DurableObjectDeletionAllowlist
	const renamedMigration = createConfig(undefined)
	renamedMigration.migrations[0] = {
		tag: 'renamed-v1',
		new_sqlite_classes: ['Mailbox'],
	}
	expect(
		checkDurableObjectConfig(configPath, renamedMigration, baseline, allowlist),
	).toEqual([
		expect.stringContaining('was removed, renamed, or changed'),
		expect.stringContaining(
			'new_sqlite_classes migration "renamed-v1" is not recorded',
		),
	])

	const removedBinding = createConfig(undefined)
	removedBinding.env.production.durable_objects.bindings = []
	expect(
		checkDurableObjectConfig(configPath, removedBinding, baseline, allowlist),
	).toEqual([
		expect.stringContaining(
			'protected Durable Object class "Mailbox" was removed',
		),
	])

	const renamedBinding = createConfig(undefined)
	renamedBinding.env.production.durable_objects.bindings[0] = {
		name: 'RENAMED_MAILBOX',
		class_name: 'Mailbox',
	}
	expect(
		checkDurableObjectConfig(configPath, renamedBinding, baseline, allowlist),
	).toEqual([expect.stringContaining('binding identities')])

	const retargetedBinding = createConfig(undefined)
	Object.assign(
		retargetedBinding.env.production.durable_objects.bindings[0] ?? {},
		{
			script_name: 'external-worker',
			environment: 'production',
		},
	)
	expect(
		checkDurableObjectConfig(
			configPath,
			retargetedBinding,
			baseline,
			allowlist,
		),
	).toEqual([expect.stringContaining('binding identities')])
})

test('workflow guard permits destructive commands only in operator-dispatched jobs', () => {
	const automaticWorkflow = `on:
  push:
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - run: npx wrangler d1 delete production
`
	expect(checkWorkflowSource('automatic.yml', automaticWorkflow)).toEqual([
		expect.stringContaining(
			'invokes a destructive Cloudflare CLI operation outside a job',
		),
	])

	const manualWorkflow = `on:
  workflow_dispatch:
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - run: npx wrangler r2 bucket delete old-backups
`
	expect(checkWorkflowSource('manual.yml', manualWorkflow)).toEqual([])

	const explicitlyGuardedMixedWorkflow = `on:
  push:
  workflow_dispatch:
jobs:
  cleanup:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - run: node ./wrangler-env.ts kv namespace delete old-cache
`
	expect(
		checkWorkflowSource('mixed.yml', explicitlyGuardedMixedWorkflow),
	).toEqual([])

	const bypassableMixedWorkflow = explicitlyGuardedMixedWorkflow.replace(
		"github.event_name == 'workflow_dispatch'",
		"github.event_name == 'workflow_dispatch' || github.event_name == 'push'",
	)
	expect(
		checkWorkflowSource('bypassable.yml', bypassableMixedWorkflow),
	).toEqual([expect.stringContaining('outside a job explicitly restricted')])
})

test('current repository deploy configuration passes the guardrails', async () => {
	await expect(checkDeployGuardrails()).resolves.toEqual({
		ok: true,
		errors: [],
	})
})
