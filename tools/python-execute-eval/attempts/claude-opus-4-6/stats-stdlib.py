import statistics

def main(params):
    values = params["values"]
    return {
        "mean": round(statistics.mean(values), 6),
        "median": statistics.median(values),
        "pstdev": round(statistics.pstdev(values), 6),
    }
