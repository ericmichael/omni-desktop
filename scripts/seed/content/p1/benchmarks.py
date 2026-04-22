import marimo

__generated_with = "0.9.0"
app = marimo.App()


@app.cell
def __():
    import marimo as mo
    return (mo,)


@app.cell
def __(mo):
    mo.md(
        r"""
        # Heap benchmarks

        Compare our Rust min-heap implementation against `std::collections::BinaryHeap`.

        Populate the plot once the `bench` binary emits its JSON to `target/bench.json`.
        """
    )
    return


@app.cell
def __():
    import json
    from pathlib import Path

    bench_path = Path("target/bench.json")
    data = json.loads(bench_path.read_text()) if bench_path.exists() else []
    return bench_path, data, json


@app.cell
def __(data, mo):
    mo.md(f"Loaded **{len(data)}** benchmark rows.")
    return


if __name__ == "__main__":
    app.run()
