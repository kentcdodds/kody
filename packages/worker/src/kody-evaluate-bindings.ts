/**
 * Names inside the dynamic-worker `evaluate()` scope.
 *
 * The capability proxy is not bound as `kody`. Agents call builtins through
 * `import { kody } from 'kody:runtime'`. Helper preludes call the dispatcher
 * directly so one-file snippets in that same scope cannot see a bare `kody`.
 */
export const kodyProviderEvaluateBindingName = '__kodyProvider'
export const kodyCallDispatcherName = '__kodyCallDispatcher'
