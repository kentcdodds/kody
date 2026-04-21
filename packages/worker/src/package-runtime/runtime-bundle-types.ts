import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { type BundleArtifactDependency } from './published-runtime-artifacts.ts'

export type RuntimeBundle = {
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
}
