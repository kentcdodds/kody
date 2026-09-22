import numpy as np

def main(params):
    values = params["values"]
    return {"mean": round(float(np.mean(values)), 6)}
