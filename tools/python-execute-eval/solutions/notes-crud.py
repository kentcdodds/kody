async def main(params):
    for operation in params["ops"]:
        if operation["op"] == "write":
            await kody.call("notes.write", {
                "id": operation["id"],
                "text": operation["text"],
            })
        elif operation["op"] == "remove":
            await kody.call("notes.remove", {"id": operation["id"]})
    return await kody.call("notes.list", {})
