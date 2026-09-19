/**
 * Names inside the dynamic-worker `evaluate()` scope.
 *
 * The capability proxy is not bound as `kody`. Agents call builtins through
 * `import { kody } from 'kody:runtime'`. Helper preludes call the dispatcher
 * directly. One-file snippets are wrapped so these names are not visible.
 */
export const kodyProviderEvaluateBindingName = '__kodyProvider'
export const kodyCallDispatcherName = '__kodyCallDispatcher'
