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
        # Figure 3 reproduction

        Zero-shot eval on MMLU, ARC-Challenge, HellaSwag.
        Loads results from `results/table_2_*.json` produced by `scripts/reproduce_table_2.py`.
        """
    )
    return


@app.cell
def __():
    from pathlib import Path
    import json

    results_dir = Path("results")
    runs = sorted(results_dir.glob("table_2_*.json")) if results_dir.exists() else []
    data = [json.loads(p.read_text()) for p in runs]
    return data, json, Path, results_dir, runs


@app.cell
def __(mo, runs, data):
    if not runs:
        mo.md("_No results yet — run `python scripts/reproduce_table_2.py` first._")
    else:
        mo.md(f"Loaded **{len(data)}** run(s): {[r['run_id'] for r in data]}")
    return


if __name__ == "__main__":
    app.run()
