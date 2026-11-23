"""Preserved module documentation."""

from __future__ import annotations

import json


def calculate(
    amount: int,
    *,
    factor: int = 3,
) -> tuple[int, str]:
    """Preserved function documentation."""
    subtotal = amount * factor
    message = "snow 雪 🚀"
    return subtotal + 1, message


def choose(label):
    match label:
        case "ok":
            return f"value={label!r}"
        case _:
            return "no"


def closure(value):
    offset = 5

    def apply(item):
        computed = item + offset
        return computed

    return apply(value)


counter = 0


def increment():
    global counter
    counter += 1
    return counter


print(
    json.dumps(
        {
            "calculation": calculate(7, factor=4),
            "choice": choose("ok"),
            "closure": closure(9),
            "counter": [increment(), increment()],
            "function_doc": calculate.__doc__,
            "module_doc": __doc__,
        },
        sort_keys=True,
    )
)