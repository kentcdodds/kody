import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { normalizePackageNameInput } from '#worker/package-registry/package-name.ts'
import { type PackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { assertKodyDescriptionLength } from '#worker/package-registry/types.ts'
import { upsertSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'

export const defaultStubPackageDescription =
	'Stub package created for a clone-edit-push workflow. Replace this description on the first real publish.'

export function buildStubPackageFiles(input: {
	name: string
	description: string
}): Record<string, string> {
	const packageJson = {
		name: input.name,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			description: input.description,
		},
	}
	return {
		'package.json': `${JSON.stringify(packageJson, null, '\t')}\n`,
		'README.md': [
			`# ${input.name}`,
			'',
			'## Intent',
			'',
			input.description,
			'',
			'Update this Intent section to capture the user-defined goal before',
			'publishing real package source.',
			'',
		].join('\n'),
		'AGENTS.md': [
			`# ${input.name}`,
			'',
			'Agent-focused notes: imports, smoke tests, and edge cases.',
			'',
			'## Imports',
			'',
			'```ts',
			`import main from 'kody:${input.name}'`,
			'```',
			'',
			'## Smoke tests',
			'',
			'Call the root export from `execute` after publish.',
			'',
			'## Edge cases',
			'',
			'Replace this stub before the first real publish.',
			'',
		].join('\n'),
		'src/index.ts': [
			'export default async function main() {',
			"\treturn { status: 'stub' }",
			'}',
			'',
		].join('\n'),
	}
}

export async function createStubSavedPackage(input: {
	env: Env
	baseUrl: string
	owner: PackageOwnerContext
	packageName: string
	description?: string
}) {
	const packageSlug = normalizePackageNameInput({
		value: input.packageName,
		ownerScope: input.owner.ownerScope,
		action: 'create',
	})
	await assertWithinEntitlement({
		db: input.env.APP_DB,
		userId: input.owner.ownerUserId,
		email: input.owner.ownerEmail,
		resource: 'saved_packages',
	})
	const name = `@${input.owner.ownerScope}/${packageSlug}`
	const description = input.description?.trim() || defaultStubPackageDescription
	assertKodyDescriptionLength(description)
	const files = buildStubPackageFiles({ name, description })
	const packageJsonContent = files['package.json']
	if (!packageJsonContent) {
		throw new Error('Stub package files are missing package.json.')
	}
	const manifest = parseAuthoredPackageJson({
		content: packageJsonContent,
		manifestPath: 'package.json',
		expectedPackageScope: input.owner.ownerScope,
	})
	const packageId = crypto.randomUUID()
	const ensuredSource = await ensureEntitySource({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.owner.ownerUserId,
		entityKind: 'package',
		entityId: packageId,
		sourceRoot: '/',
		manifestPath: 'package.json',
		requirePersistence: true,
	})
	await syncArtifactSourceSnapshot({
		env: input.env,
		userId: input.owner.ownerUserId,
		baseUrl: input.baseUrl,
		sourceId: ensuredSource.id,
		bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
		files,
	})
	const now = new Date().toISOString()
	await insertSavedPackage(input.env.APP_DB, {
		id: packageId,
		user_id: input.owner.ownerUserId,
		name: manifest.name,
		kody_id: manifest.kody.id,
		description: manifest.kody.description,
		tags_json: JSON.stringify(manifest.kody.tags ?? []),
		search_text: manifest.kody.searchText ?? null,
		source_id: ensuredSource.id,
		has_app: 0,
		hidden: 0,
		is_private: 1,
		created_at: now,
		updated_at: now,
	})
	await upsertSavedPackageVector(input.env, {
		packageId,
		userId: input.owner.ownerUserId,
		embedText: buildSavedPackageEmbedText(manifest),
	})
	await refreshSavedPackageProjection({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.owner.ownerUserId,
		packageId,
		sourceId: ensuredSource.id,
	})
	return {
		packageId,
		packageName: manifest.kody.id,
		name: manifest.name,
	}
}
