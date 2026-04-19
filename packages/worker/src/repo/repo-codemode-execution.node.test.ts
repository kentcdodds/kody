import { expect, test, vi } from 'vitest'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

const mockModule = vi.hoisted(() => ({
	createWorker: vi.fn(),
}))

vi.mock('@cloudflare/worker-bundler', () => ({
	createWorker: (...args: Array<unknown>) => mockModule.createWorker(...args),
}))

import {
	buildRepoCodemodeBundle,
	createRepoCodemodeModuleTypecheckHarness,
} from './repo-codemode-execution.ts'

test('createRepoCodemodeModuleTypecheckHarness omits TypeScript file extensions from generated imports', () => {
	const harness = createRepoCodemodeModuleTypecheckHarness({
		entryPoint: 'src/job.ts',
	})

	expect(harness).toContain('import userEntrypoint from "./src/job"')
	expect(harness).not.toContain('./src/job.ts')
})

test('buildRepoCodemodeBundle emits an extensionless synthetic ESM re-export for TypeScript entrypoints', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue({
		mainModule: 'dist/job.js',
		modules: {
			'dist/job.js': 'export default async () => ({ ok: true })\n',
		} satisfies WorkerLoaderModules,
	})

	const bundle = await buildRepoCodemodeBundle({
		sourceFiles: {
			'src/job.ts': 'export default async () => ({ ok: true })\n',
		},
		entryPoint: 'src/job.ts',
		entryPointSource: 'export default async () => ({ ok: true })\n',
	})

	expect(mockModule.createWorker).toHaveBeenCalledWith({
		files: {
			'src/job.ts': 'export default async () => ({ ok: true })\n',
			'.__kody_repo_user_entry__.ts': 'export { default } from "./src/job";\n',
		},
		entryPoint: '.__kody_repo_user_entry__.ts',
	})
})
