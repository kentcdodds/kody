import numpy


def main(params):
    return {"mean": round(float(numpy.mean(params["values"])), 6)}
