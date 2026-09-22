"""CPython twin of the experimental Python execute sandbox.

Protocol (newline-delimited JSON on stdin/stdout):

1. Parent writes {"source", "params"}.
2. Child writes {"type": "call", "name", "args"} and waits for
   {"ok": true, "value"} or {"ok": false, "error"}.
3. Child writes {"type": "done", "ok", "result"|"error", "errorName", "logs", "cpuMs"}.

The allowed-module tuple matches packages/worker/src/mcp/python-execute/allowed-modules.ts.
"""

import builtins
import json
import sys
import traceback

_ALLOWED = (
    "array",
    "bisect",
    "collections",
    "copy",
    "csv",
    "dataclasses",
    "datetime",
    "decimal",
    "enum",
    "fractions",
    "functools",
    "heapq",
    "io",
    "itertools",
    "json",
    "math",
    "numbers",
    "operator",
    "random",
    "re",
    "statistics",
    "string",
    "textwrap",
    "typing",
)

_CONTRACT = "Python execute modules define async def main(params) or def main(params)."

_real_import = builtins.__import__


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    filename = sys._getframe(1).f_code.co_filename
    if filename == "<python-execute>" and root not in _ALLOWED:
        raise ImportError("blocked module: " + root)
    return _real_import(name, globals, locals, fromlist, level)


def _read_message():
    line = sys.stdin.readline()
    if line == "":
        raise SystemExit(0)
    return json.loads(line)


def _write_message(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _cpu_sample():
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        return usage.ru_utime + usage.ru_stime
    except Exception:
        return None


class KodyBridge:
    async def call(self, name, args=None):
        payload = {} if args is None else args
        if not isinstance(payload, dict):
            raise RuntimeError("kody.call args are a JSON object.")
        _write_message({"type": "call", "name": name, "args": payload})
        reply = _read_message()
        if not reply.get("ok"):
            raise RuntimeError(reply.get("error") or "capability failed")
        return reply.get("value")


async def _run():
    job = _read_message()
    source = job.get("source") or ""
    params = job.get("params") or {}
    logs = []
    started = _cpu_sample()
    builtins.__import__ = _guarded_import

    def _print(*args, **kwargs):
        logs.append(" ".join(str(arg) for arg in args))

    namespace = {
        "__name__": "kody_python_execute",
        "kody": KodyBridge(),
        "params": params,
        "print": _print,
    }
    try:
        exec(compile(source, "<python-execute>", "exec"), namespace)
        main = namespace.get("main")
        if main is None:
            raise RuntimeError(_CONTRACT)
        result = main(params)
        if hasattr(result, "__await__"):
            result = await result
        _write_message(
            {
                "type": "done",
                "ok": True,
                "result": result,
                "logs": logs,
                "cpuMs": _cpu_ms(started),
            }
        )
    except Exception as error:
        _write_message(
            {
                "type": "done",
                "ok": False,
                "error": str(error),
                "errorName": type(error).__name__,
                "logs": logs,
                "cpuMs": _cpu_ms(started),
                "trace": traceback.format_exc(),
            }
        )


def _cpu_ms(started):
    if started is None:
        return None
    ended = _cpu_sample()
    if ended is None:
        return None
    return int((ended - started) * 1000)


if __name__ == "__main__":
    import asyncio

    asyncio.run(_run())
