async def main(params):
    ops = params.get("ops", [])
    for op in ops:
        if op["op"] == "write":
            await kody.call("notes.write", {"id": op["id"], "text": op["text"]})
        elif op["op"] == "remove":
            await kody.call("notes.remove", {"id": op["id"]})
    return await kody.call("notes.list", {})
