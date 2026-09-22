async def main(params):
    try:
        await kody.call("notes.get", {"id": params["id"]})
        return {"recovered": False, "reason": "note exists"}
    except RuntimeError as e:
        return {"recovered": True, "reason": str(e)}
