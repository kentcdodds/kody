// `gss-lang/vite` turns a `.gss` stylesheet into its compiled scene.
declare module '*.gss' {
	import { type CompiledScene } from 'gss-lang/runtime'
	const scene: CompiledScene
	export default scene
}
