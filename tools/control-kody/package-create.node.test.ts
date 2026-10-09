import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	createPreviewPackage,
	formatPackageCreateReport,
	headAheadFileName,
	isLowerKebabKodyId,
	matchesCreatedPackage,
	isProductionKodyOrigin,
	pushHeadAheadCommit,
	usernameFromPackageName,
	type PackageCreateCallTool,
} from './package-create.ts'

const previewOrigin = 'https://kody-pr-9.kody.workers.dev'

function create(
	overrides: Partial<Parameters<typeof createPreviewPackage>[0]> = {},
) {
	return createPreviewPackage({
		origin: previewOrigin,
		email: 'me@kentcdodds.com',
		password: 'ilikecode',
		kodyId: 'preview-pkg',
		headAhead: false,
		...overrides,
	})
}

function connectWith(callTool: PackageCreateCallTool) {
	return async () => ({
		cookieHeader: 'kody_session=abc',
		client: { callTool },
	})
}

function executeResult(result: unknown) {
	return { isError: false, structuredContent: { result } }
}

const remoteMissingResult = executeResult({
	remote: null,
	remoteError: 'account not found',
	detail: {
		package_id: 'pkg-1',
		kody_id: 'preview-pkg',
		name: '@user-me/preview-pkg',
	},
})

test('package-create builds preview URLs, reports JSON shape, and can leave HEAD ahead', async () => {
	const kodyIdCases: Array<[string, boolean]> = [
		['preview-pkg', true],
		['@user-me/preview-pkg', true],
		['pkg', true],
		['Not-A-Slug', false],
		['other/preview-pkg', false],
		['///preview-pkg', false],
	]
	expect(
		kodyIdCases.filter(([kodyId, want]) => isLowerKebabKodyId(kodyId) !== want),
	).toEqual([])
	const requestedCases: Array<[string, boolean]> = [
		['preview-pkg', true],
		['@user-me/preview-pkg', true],
		['@other/preview-pkg', false],
	]
	expect(
		requestedCases.filter(
			([requested, want]) =>
				matchesCreatedPackage({
					requested,
					kodyId: 'preview-pkg',
					name: '@user-me/preview-pkg',
				}) !== want,
		),
	).toEqual([])
	const originCases: Array<[string, boolean]> = [
		['https://kody.codes', true],
		['https://www.kody.codes', true],
		['https://kody.codes.', true],
		['https://www.kody.codes.', true],
		[previewOrigin, false],
	]
	expect(
		originCases.filter(
			([origin, want]) => isProductionKodyOrigin(origin) !== want,
		),
	).toEqual([])
	expect(usernameFromPackageName('@user-me/preview-pkg', 'preview-pkg')).toBe(
		'user-me',
	)
	expect(usernameFromPackageName('preview-pkg', 'preview-pkg')).toBeNull()

	let pushedRemote: string | null = null
	const report = await create({
		description: 'preview fixture',
		headAhead: true,
		connect: connectWith(async (params, options) => {
			expect(params.name).toBe('execute')
			expect(options?.timeout).toBeGreaterThan(60_000)
			expect(options?.resetTimeoutOnProgress).toBe(true)
			const args = params.arguments as {
				code: string
				params: { kodyId: string; description?: string }
			}
			expect(args.code).toContain('packageGetGitRemote')
			expect(args.code).toContain('packageGet')
			expect(args.code).toContain(
				'kodyId === requested || pkg.name === requested',
			)
			expect(args.params).toEqual({
				kodyId: 'preview-pkg',
				description: 'preview fixture',
				requireRemote: true,
			})
			return executeResult({
				remote: {
					package_id: 'pkg-1',
					kody_id: 'preview-pkg',
					created: true,
					authenticated_remote: 'https://x:token@artifacts.example/git/pkg-1',
					git_author: { name: 'Me', email: 'me@kentcdodds.com' },
					setup_commands: [
						"git config --local user.email -- 'me@kentcdodds.com'",
						"git config --local user.name -- 'Me'",
					],
				},
				detail: { name: '@user-me/preview-pkg' },
			})
		}),
		pushHeadAhead: async (remote) => {
			pushedRemote = remote.authenticated_remote
		},
	})
	expect(report).toMatchObject({
		ok: true,
		packageId: 'pkg-1',
		kodyId: 'preview-pkg',
		name: '@user-me/preview-pkg',
		created: true,
		username: 'user-me',
		packagePagePath: '/@user-me/preview-pkg',
		accountPackagePath: '/account/packages/pkg-1',
		packagePageUrl: `${previewOrigin}/@user-me/preview-pkg`,
		accountPackageUrl: `${previewOrigin}/account/packages/pkg-1`,
		headAhead: true,
		cookieHeader: 'kody_session=abc',
	})
	expect(pushedRemote).toBe('https://x:token@artifacts.example/git/pkg-1')
	expect(formatPackageCreateReport(report)).toBe(
		[
			'packageId pkg-1',
			'kodyId preview-pkg',
			'name @user-me/preview-pkg',
			`package-page ${previewOrigin}/@user-me/preview-pkg`,
			`account-page ${previewOrigin}/account/packages/pkg-1`,
			'head-ahead pushed',
		].join('\n'),
	)

	const recovered = await create({
		connect: connectWith(async () => remoteMissingResult),
	})
	expect(recovered.packageId).toBe('pkg-1')
	expect(recovered.headAhead).toBe(false)

	const scoped = await create({
		kodyId: '@user-me/preview-pkg',
		connect: connectWith(async (params) => {
			const args = params.arguments as {
				code: string
				params: { kodyId: string }
			}
			expect(args.params.kodyId).toBe('@user-me/preview-pkg')
			expect(args.code).toContain(
				'kodyId === requested || pkg.name === requested',
			)
			return remoteMissingResult
		}),
	})
	expect(scoped).toMatchObject({
		packageId: 'pkg-1',
		kodyId: 'preview-pkg',
		name: '@user-me/preview-pkg',
	})

	const rejections: Array<
		[Partial<Parameters<typeof createPreviewPackage>[0]>, RegExp]
	> = [
		[
			{ origin: 'https://kody.codes' },
			/refuses to run against https:\/\/kody\.codes/,
		],
		[
			{ origin: 'https://kody.codes.' },
			/refuses to run against https:\/\/kody\.codes/,
		],
		[{ kodyId: 'other/preview-pkg' }, /lower-kebab-case leaf or @scope\/leaf/],
		[
			{
				connect: connectWith(async () => ({
					isError: true,
					content: [
						{ type: 'text', text: 'Saved package not found for this user.' },
					],
					structuredContent: { error: 'missing' },
				})),
			},
			/execute failed: Saved package not found/,
		],
	]
	for (const [overrides, message] of rejections) {
		await expect(create(overrides)).rejects.toThrow(message)
	}

	const parent = await mkdtemp(path.join(tmpdir(), 'control-kody-head-ahead-'))
	try {
		const bare = path.join(parent, 'remote.git')
		const seed = path.join(parent, 'seed')
		const git = (...args: Array<string>) =>
			execFileSync('git', args, { encoding: 'utf8' })
		git('init', '--bare', bare)
		git('clone', '--quiet', bare, seed)
		git('-C', seed, 'config', 'user.email', 'me@example.com')
		git('-C', seed, 'config', 'user.name', 'Me')
		await writeFile(path.join(seed, 'README.md'), 'stub\n')
		git('-C', seed, 'add', 'README.md')
		git('-C', seed, 'commit', '-m', 'init')
		git('-C', seed, 'push', '--quiet', 'origin', 'HEAD')

		const remote = {
			package_id: 'pkg-1',
			kody_id: 'preview-pkg',
			authenticated_remote: bare,
			git_author: { name: 'Me', email: 'me@example.com' },
			setup_commands: [
				"git config --local user.email -- 'me@example.com'",
				"git config --local user.name -- 'Me'",
			],
		}
		await pushHeadAheadCommit(remote)
		expect(git('--git-dir', bare, 'log', '--oneline')).toMatch(
			/leave HEAD ahead of published/,
		)
		expect(
			git('--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'),
		).toContain(headAheadFileName)

		await pushHeadAheadCommit(remote)
		expect(
			git('--git-dir', bare, 'log', '--oneline').match(
				/leave HEAD ahead of published/g,
			),
		).toHaveLength(1)
	} finally {
		await rm(parent, { recursive: true, force: true })
	}
})
