"""SciPy stand-in for the `lap` package.

Ultralytics' ByteTrack imports `lap` and, when it's missing, tries to
pip-install it at runtime. A school PC must not install packages on its own,
so the runtime registers this module as `lap` instead. Only `lapjv` with
`extend_cost=True` and a `cost_limit` is implemented — exactly what
ultralytics.trackers.utils.matching uses.
"""

from __future__ import annotations

import importlib.util
import sys

import numpy as np
from scipy.optimize import linear_sum_assignment

__version__ = "0-k9-scipy-shim"


def lapjv(cost, extend_cost: bool = True, cost_limit: float = np.inf, return_cost: bool = True):
    cost = np.nan_to_num(np.asarray(cost, dtype=np.float64), nan=np.inf, posinf=np.inf)
    rows, cols = cost.shape
    x = np.full(rows, -1, dtype=np.int64)
    y = np.full(cols, -1, dtype=np.int64)
    if rows == 0 or cols == 0:
        return 0.0, x, y

    # Pairs above the limit may never be matched; give them a cost no valid
    # assignment can prefer, then drop them from the solution.
    finite = cost[np.isfinite(cost)]
    ceiling = (float(finite.max()) if finite.size else 0.0) + 1.0
    limit = cost_limit if np.isfinite(cost_limit) else ceiling
    blocked = (cost > limit) | ~np.isfinite(cost)
    solvable = np.where(blocked, ceiling * max(rows, cols) + limit + 1.0, cost)

    total = 0.0
    for i, j in zip(*linear_sum_assignment(solvable)):
        if not blocked[i, j]:
            x[i], y[j] = j, i
            total += cost[i, j]
    return total, x, y


def install() -> None:
    """Register this module as `lap` unless the real package is installed."""
    if "lap" not in sys.modules and importlib.util.find_spec("lap") is None:
        sys.modules["lap"] = sys.modules[__name__]
