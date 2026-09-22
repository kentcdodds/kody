async def main(params):
    try:
        await kody.call("notes.get", {"id": params["id"]})
        return {"recovered": False}
    except Exception as error:
        return {"recovered": True, "reason": str(error)}
