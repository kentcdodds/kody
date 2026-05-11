import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactDynamicDependency,
} from './published-runtime-artifacts.ts'

export type RuntimeBundle = {
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencies?: Array<BundleArtifactDynamicDependency>
}
