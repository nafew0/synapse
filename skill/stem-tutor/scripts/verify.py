"""Check maths before it is shown: identities, derivatives, integrals, roots and numeric answers.

    python3 verify.py "CHECK" ["CHECK" ...]

Each CHECK is `left == right` in sympy syntax (`^` works for powers, `2x` for 2*x), with optional
values after a bar: `x**2 - 5*x + 6 == 0 | x=2`. A right side that is a plain number, such as
`19.8`, passes when the left side rounds to it at the digits given, so `sqrt(2*9.81*20) == 19.8`
passes. Anything else is compared symbolically, then at five random points.

Exit codes: 0 every check passed, 2 a check failed, 1 a check could not be read.
"""

import argparse
import random
import re
import sys

import sympy
from sympy.parsing.sympy_parser import (convert_xor, implicit_multiplication_application, parse_expr,
                                        standard_transformations)

TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)
NUMBER = re.compile(r"\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*")
POINTS = 5
RTOL = 1e-9


class CheckError(ValueError):
    pass


def parse(text):
    try:
        return parse_expr(text, transformations=TRANSFORMS, local_dict={"e": sympy.E, "pi": sympy.pi})
    except Exception as error:  # sympy raises many unrelated types for bad input
        raise CheckError(f"cannot read {text!r}: {error}") from error


def split(check):
    body, _, values = check.partition("|")
    if body.count("==") != 1:
        raise CheckError(f"write the check as `left == right`: {check!r}")
    left, right = (side.strip() for side in body.split("=="))
    subs = {}
    for pair in filter(None, (item.strip() for item in values.split(","))):
        name, _, value = pair.partition("=")
        if not value:
            raise CheckError(f"write values as `x=2`: {pair!r}")
        subs[sympy.Symbol(name.strip())] = parse(value)
    return left, right, subs


def tolerance(literal):
    """Half a unit in the last digit written: 19.8 allows ±0.05, 20 allows ±0.5."""
    mantissa, _, exponent = literal.strip().lower().partition("e")
    decimals = len(mantissa.split(".")[1]) if "." in mantissa else 0
    return 0.5 * 10 ** (-decimals + int(exponent or 0))


def close(a, b):
    return abs(a - b) <= RTOL * max(1.0, abs(a), abs(b))


def numeric(expr):
    value = complex(sympy.N(expr, 30))
    if abs(value.imag) > 1e-12 * max(1.0, abs(value.real)):
        raise CheckError(f"{expr} is not a real number")
    return value.real


def check_one(check, rng):
    left_text, right_text, subs = split(check)
    left = parse(left_text).subs(subs)
    if NUMBER.fullmatch(right_text) and not left.free_symbols:
        got, want = numeric(left), float(right_text)
        allowed = tolerance(right_text)
        ok = abs(got - want) <= allowed + 1e-12
        return ok, f"{got:.6g} vs {right_text} (±{allowed:g})"
    right = parse(right_text).subs(subs)
    if sympy.simplify(left - right) == 0:
        return True, "symbolic"
    symbols = sorted((left - right).free_symbols, key=str)
    for _ in range(POINTS):
        point = {symbol: sympy.Rational(rng.randint(5, 25), 10) for symbol in symbols}
        a, b = numeric(left.subs(point)), numeric(right.subs(point))
        if not close(a, b):
            where = ", ".join(f"{symbol}={value}" for symbol, value in point.items()) or "as written"
            return False, f"left {a:.6g}, right {b:.6g} at {where}"
    return True, f"numeric at {POINTS} points" if symbols else "numeric"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("checks", nargs="+")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 1
    rng = random.Random(7)
    failed, unreadable = 0, 0
    for check in args.checks:
        try:
            ok, detail = check_one(check, rng)
        except CheckError as error:
            unreadable += 1
            print(f"ERROR {check}: {error}")
            continue
        failed += not ok
        print(f"{'PASS ' if ok else 'FAIL '} {check}  ({detail})")
    print(f"{len(args.checks) - failed - unreadable} of {len(args.checks)} passed")
    return 1 if unreadable else 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
