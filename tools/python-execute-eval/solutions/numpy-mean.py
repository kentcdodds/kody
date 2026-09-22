import numpy as np


def main(params):
    return {"mean": round(float(np.mean(params["values"])), 6)}
