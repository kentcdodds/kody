async def main(params):
    try:
        await kody.call("notes.get", {"id": params["id"]})
    except Exception as error:
        return {"recovered": True, "reason": str(error)}
    return {"recovered": False, "reason": ""}
