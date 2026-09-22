import statistics


def main(params):
    values = params["values"]
    return {
        "mean": round(statistics.mean(values), 6),
        "median": round(statistics.median(values), 6),
        "pstdev": round(statistics.pstdev(values), 6),
    }
