import numpy as np


async def main(params):
    values = params["values"]
    return {"mean": round(float(np.mean(values)), 6)}
