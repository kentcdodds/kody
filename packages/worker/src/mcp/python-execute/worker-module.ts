import { pythonExecuteAllowedModules } from './allowed-modules.ts'
import { pythonExecuteContractMessage } from './language.ts'

/**
 * Python Worker Loader entry. User source is base64 so embedding it cannot
 * break the harness. `kody.call` awaits `env.BRIDGE`, a loopback
 * WorkerEntrypoint installed when the isolate is first loaded. The parent
 * passes a per-call token on `evaluate` because a warm isolate keeps the
 * first binding. Return values go through `to_js` so Pyodide dicts arrive
 * as JSON objects.
 */
export function buildPythonWorkerModule(userSource: string) {
	const allowed = pythonExecuteAllowedModules
		.map((name) => JSON.stringify(name))
		.join(', ')
	return [
		'from workers import WorkerEntrypoint',
		'from pyodide.ffi import to_js',
		'from js import Object',
		'import base64',
		'import builtins',
		'import sys',
		'',
		`_ALLOWED = (${allowed})`,
		'_real_import = builtins.__import__',
		'',
		'def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):',
		'    root = name.split(".")[0]',
		'    filename = sys._getframe(1).f_code.co_filename',
		'    if filename == "<python-execute>" and root not in _ALLOWED:',
		'        raise ImportError("blocked module: " + root)',
		'    return _real_import(name, globals, locals, fromlist, level)',
		'',
		'builtins.__import__ = _guarded_import',
		`_USER_SOURCE = base64.b64decode(${JSON.stringify(encodePythonSource(userSource))}).decode("utf-8")`,
		'',
		'def _to_js(value):',
		'    return to_js(value, dict_converter=Object.fromEntries)',
		'',
		'def _cpu_sample():',
		'    try:',
		'        import resource',
		'        usage = resource.getrusage(resource.RUSAGE_SELF)',
		'        return usage.ru_utime + usage.ru_stime',
		'    except Exception:',
		'        return None',
		'',
		'class KodyBridge:',
		'    def __init__(self, bridge, token):',
		'        self._bridge = bridge',
		'        self._token = token',
		'',
		'    async def call(self, name, args=None):',
		'        payload = {} if args is None else args',
		'        if not isinstance(payload, dict):',
		'            raise RuntimeError("kody.call args are a JSON object.")',
		'        return await self._bridge.call(self._token, name, payload)',
		'',
		'class Default(WorkerEntrypoint):',
		'    async def evaluate(self, invocation):',
		'        logs = []',
		'        params = {}',
		'        token = None',
		'        if invocation is not None:',
		'            if isinstance(invocation, dict):',
		'                params = invocation.get("params") or {}',
		'                token = invocation.get("token")',
		'            else:',
		'                params = getattr(invocation, "params", None) or {}',
		'                token = getattr(invocation, "token", None)',
		'        started = _cpu_sample()',
		'',
		'        def _print(*args, **kwargs):',
		'            logs.append(" ".join(str(arg) for arg in args))',
		'',
		'        namespace = {',
		'            "__name__": "kody_python_execute",',
		'            "kody": KodyBridge(self.env.BRIDGE, token),',
		'            "params": params,',
		'            "print": _print,',
		'        }',
		'        try:',
		'            exec(compile(_USER_SOURCE, "<python-execute>", "exec"), namespace)',
		'            main = namespace.get("main")',
		'            if main is None:',
		`                raise RuntimeError(${JSON.stringify(pythonExecuteContractMessage)})`,
		'            result = main(params)',
		'            if hasattr(result, "__await__"):',
		'                result = await result',
		'            return _to_js({"result": result, "logs": logs, "cpuMs": _cpu_ms(started)})',
		'        except Exception as error:',
		'            return _to_js({',
		'                "result": None,',
		'                "error": str(error),',
		'                "errorName": type(error).__name__,',
		'                "logs": logs,',
		'                "cpuMs": _cpu_ms(started),',
		'            })',
		'',
		'def _cpu_ms(started):',
		'    if started is None:',
		'        return None',
		'    ended = _cpu_sample()',
		'    if ended is None:',
		'        return None',
		'    return int((ended - started) * 1000)',
		'',
	].join('\n')
}

function encodePythonSource(source: string) {
	const bytes = new TextEncoder().encode(source)
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}
