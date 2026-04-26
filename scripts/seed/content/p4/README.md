# paper-reproducibility

Reproduction study for *"Sparse Mixture-of-Experts at 1T Parameters"* (NeurIPS 2024).

## Goal

Reproduce Table 2 (zero-shot eval on MMLU / ARC / HellaSwag) with the released 8B baseline on our own hardware.

## Not a goal

Reproducing the full 1T run. We don't have the compute and the paper doesn't release weights above 8B.

## Quickstart

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/reproduce_table_2.py --model 8b --output results/
```

Results go to `results/table_2_<date>.json`. See `figure-3-reproduction.py` (marimo) for the chart.
