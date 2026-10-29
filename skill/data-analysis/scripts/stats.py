"""Run one statistical analysis on a sheet and write the result tables plus a plain-English interpretation.

    python3 stats.py SUBCOMMAND IN [--sheet NAME] [--header-row N] [--out results.xlsx] ...

Subcommands: describe, ttest, anova, regression, correlation, chisq, reliability, flag, compare.
Run `stats.py SUBCOMMAND -h` for its options. Each writes its tables to a sheet named after the
subcommand in --out (default /mnt/data/qa/results.xlsx; a .csv path writes the tables stacked)
and prints a short report ending with an "Interpretation:" paragraph.
Exit 0 ok, 2 ran but an assumption failed or there are warnings to pass on, 1 bad arguments.
"""

import argparse
import csv
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font
from scipy import stats as st
from statsmodels.formula.api import ols
from statsmodels.stats.anova import anova_lm
from statsmodels.stats.diagnostic import het_breuschpagan
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.outliers_influence import variance_inflation_factor
from statsmodels.stats.stattools import durbin_watson

from load import DataError, load

DEFAULT_OUT = "/mnt/data/qa/results.xlsx"
ALPHA = 0.05
SMALL_SAMPLE = 30
SHAPIRO_MAX = 5000
AGGREGATES = {"count": "count", "sum": "sum", "mean": "mean", "median": "median", "sd": "std", "min": "min", "max": "max"}


class ArgError(Exception):
    """Arguments that do not fit the data (exit 1)."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"error: {message}", file=sys.stderr)
        sys.exit(1)


@dataclass
class Result:
    title: str
    tables: list[tuple[str, pd.DataFrame]] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    interpretation: list[str] = field(default_factory=list)

    def add(self, title, frame):
        self.tables.append((title, frame))


def fmt_p(p):
    if p is None or (isinstance(p, float) and math.isnan(p)):
        return "p = n/a"
    if p < 0.001:
        return "p < .001"
    return f"p = {p:.3f}".replace("0.", ".", 1)


def fmt(value, places=2):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:,.{places}f}"


def bare(value, places=2):
    """APA style for statistics that cannot exceed 1: no leading zero (r = .45)."""
    return fmt(value, places).replace("0.", ".", 1)


def apa_p(p):
    return fmt_p(p).replace("p ", "", 1).replace("= ", "")


def significant(p):
    return p is not None and not math.isnan(p) and p < ALPHA


def d_size(d):
    d = abs(d)
    return "negligible" if d < 0.2 else "small" if d < 0.5 else "medium" if d < 0.8 else "large"


def eta_size(eta):
    return "negligible" if eta < 0.01 else "small" if eta < 0.06 else "medium" if eta < 0.14 else "large"


def r_size(r):
    r = abs(r)
    return "negligible" if r < 0.1 else "weak" if r < 0.3 else "moderate" if r < 0.5 else "strong"


def v_size(v, df):
    small = 0.1 / math.sqrt(df)
    return "negligible" if v < small else "small" if v < 3 * small else "medium" if v < 5 * small else "large"


def alpha_word(a):
    for bound, word in ((0.9, "excellent"), (0.8, "good"), (0.7, "acceptable"), (0.6, "questionable"), (0.5, "poor")):
        if a >= bound:
            return word
    return "unacceptable"


def column(data, name):
    if name in data.columns:
        return name
    folded = {str(c).strip().lower(): c for c in data.columns}
    match = folded.get(name.strip().lower())
    if match is None:
        raise ArgError(f"no column {name!r}; columns: {', '.join(map(str, data.columns))}")
    return match


def columns(data, names):
    return [column(data, name) for name in names]


def numeric(data, name):
    if not pd.api.types.is_numeric_dtype(data[name]):
        raise ArgError(f"column {name!r} is not numeric")
    return data[name]


def numeric_columns(data):
    return [c for c in data.columns if pd.api.types.is_numeric_dtype(data[c])]


def shapiro(values, label, result, alternative, large=None):
    values = np.asarray(values, dtype=float)
    values = values[~np.isnan(values)]
    if len(values) < 3:
        return None
    sample = values if len(values) <= SHAPIRO_MAX else np.random.default_rng(0).choice(values, SHAPIRO_MAX, replace=False)
    if np.ptp(sample) == 0:
        return ("Shapiro-Wilk " + label, np.nan, np.nan, "constant values")
    w, p = st.shapiro(sample)
    ok = p >= ALPHA
    large = len(values) >= SMALL_SAMPLE if large is None else large
    if not ok and not large:
        result.warnings.append(f"{label} not normal (Shapiro-Wilk W = {w:.3f}, {fmt_p(p)}, n = {len(values)}); {alternative}")
    verdict = "normal" if ok else "not normal (n >= 30 per group, test is robust)" if large else "not normal"
    return ("Shapiro-Wilk " + label, w, p, verdict)


def assumption_table(rows):
    return pd.DataFrame([r for r in rows if r], columns=["Check", "Statistic", "p", "Result"])


def describe_frame(frame, cols):
    rows = []
    for name in cols:
        s = frame[name].dropna()
        rows.append({
            "Variable": name, "N": len(s), "Missing": int(frame[name].isna().sum()), "Mean": s.mean(),
            "SD": s.std(), "SE": s.std() / math.sqrt(len(s)) if len(s) else np.nan, "Min": s.min(),
            "Q1": s.quantile(0.25), "Median": s.median(), "Q3": s.quantile(0.75), "Max": s.max(),
            "Skewness": s.skew(), "Kurtosis": s.kurt(),
        })
    return pd.DataFrame(rows)


def cmd_describe(data, args, result):
    chosen = columns(data, args.cols) if args.cols else list(data.columns)
    numbers = [c for c in chosen if pd.api.types.is_numeric_dtype(data[c])]
    texts = [c for c in chosen if c not in numbers and not pd.api.types.is_datetime64_any_dtype(data[c])]
    if args.group:
        group = column(data, args.group)
        numbers = [c for c in numbers if c != group]
        texts = [c for c in texts if c != group]
        parts = []
        for level, frame in data.groupby(group, sort=True):
            table = describe_frame(frame, numbers)
            table.insert(0, group, level)
            parts.append(table)
        if parts:
            result.add(f"Descriptive statistics by {group}", pd.concat(parts, ignore_index=True))
    elif numbers:
        result.add("Descriptive statistics", describe_frame(data, numbers))
    for name in texts:
        counts = data[name].dropna().astype(str).value_counts()
        valid = counts.sum()
        table = pd.DataFrame({name: counts.index, "Count": counts.values, "Percent": counts.values / len(data) * 100,
                              "Valid percent": counts.values / valid * 100})
        result.add(f"Frequencies: {name}", table)
    if not numbers and not texts:
        raise ArgError("no columns to describe")
    result.title = "Descriptive statistics" + (f" by {args.group}" if args.group else "")
    for name in numbers[:8]:
        s = data[name].dropna()
        if s.empty:
            continue
        sentence = f"{name}: mean {fmt(s.mean())} (SD {fmt(s.std())}), median {fmt(s.median())}, range {fmt(s.min())} to {fmt(s.max())}, n = {len(s)}."
        if abs(s.skew()) > 1:
            sentence += " The distribution is skewed, so the median is the better summary."
        result.interpretation.append(sentence)
    for name in texts[:4]:
        counts = data[name].dropna().astype(str).value_counts()
        if len(counts):
            result.interpretation.append(f"{name}: most common is {counts.index[0]!r} ({counts.iloc[0] / counts.sum():.0%} of {counts.sum()} answers).")


def group_stats(groups):
    return pd.DataFrame([
        {"Group": label, "N": len(v), "Mean": v.mean(), "SD": v.std(ddof=1), "SE": v.std(ddof=1) / math.sqrt(len(v))}
        for label, v in groups
    ])


def welch_df(a, b):
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    return (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))


def ttest_independent(data, args, result):
    dv = column(data, args.dv)
    group = column(data, args.group)
    frame = data[[dv, group]].dropna()
    numeric(data, dv)
    levels = [str(x) for x in pd.unique(frame[group].astype(str))]
    if args.groups:
        levels = args.groups
    if len(levels) != 2:
        raise ArgError(f"{group!r} has {len(levels)} groups ({', '.join(levels[:8])}); pass --groups A B or use anova")
    labels = frame[group].astype(str)
    a = frame.loc[labels == levels[0], dv].to_numpy(float)
    b = frame.loc[labels == levels[1], dv].to_numpy(float)
    if len(a) < 2 or len(b) < 2:
        raise ArgError("each group needs at least two values")
    levene = st.levene(a, b, center="mean")
    welch = args.type == "welch" or (args.type == "auto" and levene.pvalue < ALPHA)
    if args.type == "auto" and welch:
        result.warnings.append(f"variances differ (Levene F = {levene.statistic:.2f}, {fmt_p(levene.pvalue)}); Welch's t-test reported instead of Student's")
    t, p = st.ttest_ind(a, b, equal_var=not welch)
    n1, n2 = len(a), len(b)
    pooled = math.sqrt(((n1 - 1) * a.var(ddof=1) + (n2 - 1) * b.var(ddof=1)) / (n1 + n2 - 2))
    df = welch_df(a, b) if welch else n1 + n2 - 2
    se = math.sqrt(a.var(ddof=1) / n1 + b.var(ddof=1) / n2) if welch else pooled * math.sqrt(1 / n1 + 1 / n2)
    diff = a.mean() - b.mean()
    margin = st.t.ppf(0.975, df) * se
    d = diff / pooled if pooled else np.nan
    name = "Welch's t-test" if welch else "Independent-samples t-test"
    result.title = f"{name}: {dv} by {group}"
    result.add("Group statistics", group_stats([(levels[0], pd.Series(a)), (levels[1], pd.Series(b))]))
    result.add("Test", pd.DataFrame([{"Test": name, "t": t, "df": df, "p": p, "Mean difference": diff,
                                      "95% CI lower": diff - margin, "95% CI upper": diff + margin, "Cohen's d": d}]))
    rows = [("Levene (equal variances)", levene.statistic, levene.pvalue, "equal" if levene.pvalue >= ALPHA else "unequal")]
    for label, values in ((levels[0], a), (levels[1], b)):
        rows.append(shapiro(values, f"{dv} in {label}", result, "Mann-Whitney U reported as the non-parametric check"))
    if any("Mann-Whitney" in w for w in result.warnings):
        u = st.mannwhitneyu(a, b, alternative="two-sided")
        rows.append(("Mann-Whitney U (alternative)", u.statistic, u.pvalue, "differ" if u.pvalue < ALPHA else "no difference"))
    result.add("Assumptions", assumption_table(rows))
    higher, lower = (levels[0], levels[1]) if diff >= 0 else (levels[1], levels[0])
    stats_text = f"t({df:.2f}) = {t:.2f}, {fmt_p(p)}, d = {fmt(abs(d))}" if welch else f"t({df:.0f}) = {t:.2f}, {fmt_p(p)}, d = {fmt(abs(d))}"
    means = f"{levels[0]} (M = {fmt(a.mean())}, SD = {fmt(a.std(ddof=1))}, n = {n1}) and {levels[1]} (M = {fmt(b.mean())}, SD = {fmt(b.std(ddof=1))}, n = {n2})"
    if significant(p):
        result.interpretation.append(f"{dv} differed significantly between {means}: {higher} was higher by {fmt(abs(diff))}, {stats_text}, a {d_size(d)} effect.")
    else:
        result.interpretation.append(f"There was no significant difference in {dv} between {means}, {stats_text}.")


def ttest_paired(data, args, result):
    first, second = columns(data, args.cols)
    frame = data[[first, second]].dropna()
    a, b = numeric(frame, first).to_numpy(float), numeric(frame, second).to_numpy(float)
    if len(a) < 2:
        raise ArgError("need at least two complete pairs")
    diffs = a - b
    t, p = st.ttest_rel(a, b)
    df = len(a) - 1
    sd = diffs.std(ddof=1)
    margin = st.t.ppf(0.975, df) * sd / math.sqrt(len(a))
    d = diffs.mean() / sd if sd else np.nan
    result.title = f"Paired-samples t-test: {first} vs {second}"
    result.add("Paired statistics", group_stats([(first, pd.Series(a)), (second, pd.Series(b))]))
    result.add("Test", pd.DataFrame([{"Test": "Paired-samples t-test", "t": t, "df": df, "p": p, "Mean difference": diffs.mean(),
                                      "95% CI lower": diffs.mean() - margin, "95% CI upper": diffs.mean() + margin, "Cohen's dz": d}]))
    rows = [shapiro(diffs, "differences", result, "Wilcoxon signed-rank reported as the non-parametric check")]
    if result.warnings:
        w = st.wilcoxon(a, b)
        rows.append(("Wilcoxon signed-rank (alternative)", w.statistic, w.pvalue, "differ" if w.pvalue < ALPHA else "no difference"))
    result.add("Assumptions", assumption_table(rows))
    stats_text = f"t({df}) = {t:.2f}, {fmt_p(p)}, dz = {fmt(abs(d))}"
    if significant(p):
        direction = "higher" if diffs.mean() > 0 else "lower"
        result.interpretation.append(f"{first} (M = {fmt(a.mean())}) was significantly {direction} than {second} (M = {fmt(b.mean())}) across {len(a)} pairs, {stats_text}, a {d_size(d)} effect.")
    else:
        result.interpretation.append(f"{first} (M = {fmt(a.mean())}) and {second} (M = {fmt(b.mean())}) did not differ significantly across {len(a)} pairs, {stats_text}.")


def ttest_one(data, args, result):
    name = column(data, args.cols[0])
    values = numeric(data, name).dropna().to_numpy(float)
    t, p = st.ttest_1samp(values, args.mu)
    df = len(values) - 1
    d = (values.mean() - args.mu) / values.std(ddof=1)
    result.title = f"One-sample t-test: {name} against {args.mu:g}"
    result.add("Test", pd.DataFrame([{"Test": "One-sample t-test", "Test value": args.mu, "N": len(values), "Mean": values.mean(),
                                      "SD": values.std(ddof=1), "t": t, "df": df, "p": p, "Cohen's d": d}]))
    result.add("Assumptions", assumption_table([shapiro(values, name, result, "Wilcoxon signed-rank is the non-parametric check")]))
    verdict = "differed significantly from" if significant(p) else "did not differ significantly from"
    result.interpretation.append(f"The mean {name} (M = {fmt(values.mean())}, SD = {fmt(values.std(ddof=1))}, n = {len(values)}) {verdict} {args.mu:g}, t({df}) = {t:.2f}, {fmt_p(p)}, d = {fmt(abs(d))}.")


def cmd_ttest(data, args, result):
    if args.mu is not None:
        if not args.cols or len(args.cols) != 1:
            raise ArgError("a one-sample test takes --cols COLUMN --mu VALUE")
        return ttest_one(data, args, result)
    if args.cols:
        if len(args.cols) != 2:
            raise ArgError("a paired test takes --cols BEFORE AFTER")
        return ttest_paired(data, args, result)
    if args.type == "paired":
        raise ArgError("a paired test takes --cols BEFORE AFTER")
    if not args.dv or not args.group:
        raise ArgError("an independent test takes --dv COLUMN --group COLUMN")
    return ttest_independent(data, args, result)


def welch_anova(groups):
    k = len(groups)
    n = np.array([len(g) for g in groups], float)
    means = np.array([g.mean() for g in groups])
    weights = n / np.array([g.var(ddof=1) for g in groups])
    grand = (weights * means).sum() / weights.sum()
    a = (weights * (means - grand) ** 2).sum() / (k - 1)
    tmp = (((1 - weights / weights.sum()) ** 2) / (n - 1)).sum()
    f = a / (1 + 2 * (k - 2) / (k ** 2 - 1) * tmp)
    df2 = (k ** 2 - 1) / (3 * tmp)
    return f, k - 1, df2, st.f.sf(f, k - 1, df2)


def anova_model(frame, factors, ss):
    terms = [f"C(f{i}, Sum)" for i in range(len(factors))]
    model = ols("y ~ " + " * ".join(terms), data=frame).fit()
    return model, anova_lm(model, typ=ss)


def cmd_anova(data, args, result):
    dv = column(data, args.dv)
    factors = columns(data, args.iv)
    if not 1 <= len(factors) <= 2:
        raise ArgError("anova takes one or two --iv factors")
    numeric(data, dv)
    frame = data[[dv, *factors]].dropna()
    model_frame = pd.DataFrame({"y": frame[dv].astype(float)})
    for i, name in enumerate(factors):
        model_frame[f"f{i}"] = frame[name].astype(str)
        if model_frame[f"f{i}"].nunique() < 2:
            raise ArgError(f"{name!r} needs at least two groups")
    cells = model_frame.groupby([f"f{i}" for i in range(len(factors))])["y"]
    if (cells.size() < 2).any():
        raise ArgError("every group (cell) needs at least two values")
    if len(factors) == 2 and cells.ngroups < model_frame["f0"].nunique() * model_frame["f1"].nunique():
        result.warnings.append("some factor combinations have no data; the interaction cannot be fully estimated")

    model, table = anova_model(model_frame, factors, args.ss)
    names = {f"C(f{i}, Sum)": name for i, name in enumerate(factors)}
    if len(factors) == 2:
        names["C(f0, Sum):C(f1, Sum)"] = f"{factors[0]} x {factors[1]}"
    names["Residual"] = "Error"
    table = table.drop(index=[i for i in table.index if i == "Intercept"])
    error_ss = table.loc["Residual", "sum_sq"]
    rows = []
    for source, row in table.iterrows():
        effect = source != "Residual"
        rows.append({"Source": names.get(source, source), "SS": row["sum_sq"], "df": int(row["df"]), "MS": row["sum_sq"] / row["df"],
                     "F": row["F"] if effect else np.nan, "p": row["PR(>F)"] if effect else np.nan,
                     "Partial eta squared": row["sum_sq"] / (row["sum_sq"] + error_ss) if effect else np.nan})
    anova_rows = pd.DataFrame(rows)
    kind = "One-way ANOVA" if len(factors) == 1 else "Two-way ANOVA"
    result.title = f"{kind}: {dv} by {' and '.join(factors)}"
    described = cells.agg(N="size", Mean="mean", SD="std").reset_index()
    described.columns = [*factors, "N", "Mean", "SD"]
    result.add("Descriptive statistics", described)
    result.add(f"ANOVA (Type {'III' if args.ss == 3 else 'II'} sums of squares)", anova_rows)

    groups = [g.to_numpy(float) for _, g in cells]
    robust = []
    levene = st.levene(*groups, center="mean")
    checks = [("Levene (equal variances)", levene.statistic, levene.pvalue, "equal" if levene.pvalue >= ALPHA else "unequal")]
    small = cells.size().min() < 10
    checks.append(shapiro(model.resid, "residuals", result,
                          "Kruskal-Wallis reported as the non-parametric check" if len(factors) == 1 else "interpret F with caution or transform the DV",
                          large=cells.size().min() >= SMALL_SAMPLE))
    if levene.pvalue < ALPHA:
        if len(factors) == 1:
            f, df1, df2, p = welch_anova(groups)
            checks.append(("Welch's ANOVA (alternative)", f, p, f"F({df1}, {df2:.2f})"))
            welch = f"Welch's ANOVA F({df1}, {df2:.2f}) = {f:.2f}, {fmt_p(p)}"
            result.warnings.append(f"variances differ (Levene {fmt_p(levene.pvalue)}); {welch} is the robust result, and Tukey's test assumes equal variances")
            robust.append(f"Because the group variances differ, rely on {welch}.")
        else:
            result.warnings.append(f"variances differ across cells (Levene {fmt_p(levene.pvalue)}); with unequal group sizes the F tests may be unreliable")
    if len(factors) == 1 and any("Kruskal" in w for w in result.warnings):
        h = st.kruskal(*groups)
        checks.append(("Kruskal-Wallis H (alternative)", h.statistic, h.pvalue, "differ" if h.pvalue < ALPHA else "no difference"))
        robust.append(f"Because the residuals are not normal, check the Kruskal-Wallis test: H({len(groups) - 1}) = {h.statistic:.2f}, {fmt_p(h.pvalue)}.")
    result.add("Assumptions", assumption_table(checks))

    posthoc = []
    for i, name in enumerate(factors):
        if model_frame[f"f{i}"].nunique() < 3:
            continue
        tukey = pairwise_tukeyhsd(model_frame["y"], model_frame[f"f{i}"])
        summary = pd.DataFrame(tukey.summary().data[1:], columns=tukey.summary().data[0])
        summary.insert(0, "Factor", name)
        posthoc.append(summary.rename(columns={"group1": "Group 1", "group2": "Group 2", "meandiff": "Mean difference",
                                               "p-adj": "p", "lower": "95% CI lower", "upper": "95% CI upper", "reject": "Significant"})
                       .assign(Significant=lambda f: f["Significant"].map(lambda v: "yes" if v else "no")))
    if posthoc:
        result.add("Tukey HSD post-hoc comparisons", pd.concat(posthoc, ignore_index=True))

    error_df = int(table.loc["Residual", "df"])
    interaction = None
    for row in rows[:-1]:
        df1 = int(row["df"])
        stats_text = f"F({df1}, {error_df}) = {row['F']:.2f}, {fmt_p(row['p'])}, partial eta squared = {bare(row['Partial eta squared'], 3)}"
        if " x " in row["Source"]:
            interaction = row
            if significant(row["p"]):
                result.interpretation.append(f"The interaction {row['Source']} was significant ({stats_text}): the effect of {factors[0]} on {dv} depends on {factors[1]}, so read the cell means rather than the main effects alone.")
            else:
                result.interpretation.append(f"The interaction {row['Source']} was not significant ({stats_text}): the effect of each factor does not depend on the other.")
            continue
        effect = "a significant" if significant(row["p"]) else "no significant"
        size = f", a {eta_size(row['Partial eta squared'])} effect" if significant(row["p"]) else ""
        result.interpretation.append(f"There was {effect} main effect of {row['Source']} on {dv} ({stats_text}{size}).")
    for frame_ in posthoc:
        hits = frame_[frame_["Significant"] == "yes"]
        if len(hits):
            pairs = "; ".join(f"{r['Group 1']} vs {r['Group 2']} (difference {fmt(r['Mean difference'])}, {fmt_p(r['p'])})" for _, r in hits.head(6).iterrows())
            result.interpretation.append(f"Tukey post-hoc tests on {frame_['Factor'].iloc[0]}: significant pairs are {pairs}.")
        else:
            result.interpretation.append(f"Tukey post-hoc tests found no pair of {frame_['Factor'].iloc[0]} groups that differ significantly.")
    if interaction is not None and significant(interaction["p"]) and posthoc:
        result.interpretation.append("Because the interaction is significant, the post-hoc comparisons on main effects average over the other factor.")
    result.interpretation.extend(robust)
    if small:
        result.lines.append("note: small groups; non-significant results may reflect low power")


def cmd_regression(data, args, result):
    dv = column(data, args.dv)
    predictors = columns(data, args.iv)
    numeric(data, dv)
    frame = data[[dv, *predictors]].dropna()
    model_frame = pd.DataFrame({"y": frame[dv].astype(float)})
    terms, labels, dummies = [], {"Intercept": "(Constant)"}, set()
    for i, name in enumerate(predictors):
        key = f"x{i}"
        if pd.api.types.is_numeric_dtype(frame[name]):
            model_frame[key] = frame[name].astype(float)
            terms.append(key)
            labels[key] = name
        else:
            model_frame[key] = frame[name].astype(str)
            levels = sorted(model_frame[key].unique())
            terms.append(f"C({key})")
            for level in levels[1:]:
                labels[f"C({key})[T.{level}]"] = f"{name}: {level} (vs {levels[0]})"
                dummies.add(labels[f"C({key})[T.{level}]"])
    n, k = len(model_frame), len(terms)
    if n <= k + 1:
        raise ArgError(f"only {n} complete rows for {k} predictors")
    model = ols("y ~ " + " + ".join(terms), data=model_frame).fit()
    exog = model.model.exog
    names = model.model.exog_names
    vif = {names[j]: variance_inflation_factor(exog, j) for j in range(len(names)) if names[j] != "Intercept"} if len(names) > 2 else {}
    sd_y = model_frame["y"].std()
    ci = model.conf_int()
    coefficients = pd.DataFrame([{
        "Predictor": labels.get(term, term), "B": model.params[term], "SE": model.bse[term],
        "Beta": model.params[term] * model_frame[term].std() / sd_y if term in model_frame else np.nan,
        "t": model.tvalues[term], "p": model.pvalues[term], "95% CI lower": ci.loc[term, 0], "95% CI upper": ci.loc[term, 1],
        "VIF": vif.get(term, np.nan),
    } for term in names])
    summary = pd.DataFrame([{"N": n, "R": math.sqrt(max(model.rsquared, 0)), "R squared": model.rsquared,
                             "Adjusted R squared": model.rsquared_adj, "SE of estimate": math.sqrt(model.mse_resid),
                             "F": model.fvalue, "df1": int(model.df_model), "df2": int(model.df_resid), "p": model.f_pvalue,
                             "Durbin-Watson": durbin_watson(model.resid)}])
    result.title = f"Multiple linear regression (OLS): {dv} on {', '.join(predictors)}" if k > 1 else f"Linear regression (OLS): {dv} on {predictors[0]}"
    result.add("Model summary", summary)

    checks = [shapiro(model.resid, "residuals", result, "with this few cases, p-values may be off; consider a larger sample or a transformed DV")]
    bp = het_breuschpagan(model.resid, exog)
    checks.append(("Breusch-Pagan (constant variance)", bp[0], bp[1], "constant" if bp[1] >= ALPHA else "heteroscedastic"))
    if bp[1] < ALPHA:
        robust = model.get_robustcov_results(cov_type="HC3")
        coefficients["Robust SE (HC3)"] = robust.bse
        coefficients["Robust p (HC3)"] = robust.pvalues
        result.warnings.append(f"residual variance is not constant (Breusch-Pagan {fmt_p(bp[1])}); HC3 robust standard errors added, use their p-values")
    high = [labels.get(t, t) for t, v in vif.items() if v > 10]
    if high:
        result.warnings.append(f"strong multicollinearity (VIF > 10): {', '.join(high)}; their individual coefficients are unstable")
    elif any(v > 5 for v in vif.values()):
        result.lines.append("note: some VIF values are above 5 (moderate multicollinearity)")
    dw = summary["Durbin-Watson"].iloc[0]
    checks.append(("Durbin-Watson (independent errors)", dw, np.nan, "ok" if 1.5 <= dw <= 2.5 else "possible autocorrelation (matters for ordered data)"))
    if n < 10 * k:
        result.lines.append(f"note: {n} cases for {k} predictors; at least {10 * k} is the usual minimum")
    result.add("Coefficients", coefficients)
    result.add("Assumptions", assumption_table(checks))

    fit = "significant" if significant(model.f_pvalue) else "not significant"
    result.interpretation.append(
        f"The model was {fit}, F({int(model.df_model)}, {int(model.df_resid)}) = {model.fvalue:.2f}, {fmt_p(model.f_pvalue)}, "
        f"and explains {model.rsquared:.1%} of the variance in {dv} (adjusted R squared = {bare(model.rsquared_adj, 3)}, n = {n}).")
    use_robust = "Robust p (HC3)" in coefficients
    for _, row in coefficients.iloc[1:].iterrows():
        p = row["Robust p (HC3)"] if use_robust else row["p"]
        if significant(p):
            direction = "increase" if row["B"] > 0 else "decrease"
            unit = "being in this group rather than the reference" if row["Predictor"] in dummies else f"each one-unit increase in {row['Predictor']}"
            result.interpretation.append(f"{row['Predictor']} is a significant predictor (B = {fmt(row['B'], 3)}, {fmt_p(p)}): {unit} goes with a {fmt(abs(row['B']), 3)} {direction} in {dv}, holding the other predictors constant.")
    weak = [row["Predictor"] for _, row in coefficients.iloc[1:].iterrows() if not significant(row["Robust p (HC3)"] if use_robust else row["p"])]
    if weak:
        result.interpretation.append(f"Not significant: {', '.join(weak)}.")


def cmd_correlation(data, args, result):
    names = columns(data, args.cols) if args.cols else numeric_columns(data)
    names = [numeric(data, n).name for n in names]
    if len(names) < 2:
        raise ArgError("correlation needs at least two numeric columns")
    method = args.method
    test = st.pearsonr if method == "pearson" else st.spearmanr
    label = "r" if method == "pearson" else "rho"
    r_matrix = pd.DataFrame(np.eye(len(names)), index=names, columns=names)
    p_matrix = pd.DataFrame(np.full((len(names), len(names)), np.nan), index=names, columns=names)
    pairs = []
    non_normal = []
    for name in names if method == "pearson" else []:
        values = data[name].dropna()
        if 3 <= len(values) < SMALL_SAMPLE and np.ptp(values) > 0 and st.shapiro(values).pvalue < ALPHA:
            non_normal.append(name)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            frame = data[[a, b]].dropna()
            if len(frame) < 3 or frame[a].nunique() < 2 or frame[b].nunique() < 2:
                r, p = np.nan, np.nan
            else:
                r, p = test(frame[a], frame[b])
            r_matrix.loc[a, b] = r_matrix.loc[b, a] = r
            p_matrix.loc[a, b] = p_matrix.loc[b, a] = p
            row = {"Variable 1": a, "Variable 2": b, label: r, "p": p, "N": len(frame), "Strength": r_size(r) if not math.isnan(r) else "n/a"}
            if non_normal and len(frame) >= 3:
                rho, rho_p = st.spearmanr(frame[a], frame[b])
                row.update({"Spearman rho": rho, "Spearman p": rho_p})
            pairs.append(row)
    if non_normal:
        result.warnings.append(f"not normal (Shapiro-Wilk, n < 30): {', '.join(non_normal)}; Spearman's rho added as the alternative")
    title = "Pearson correlation" if method == "pearson" else "Spearman rank correlation"
    result.title = f"{title}: {', '.join(names)}"
    result.add(f"Correlation matrix ({label})", r_matrix.reset_index().rename(columns={"index": "Variable"}))
    result.add("p-values (two-tailed)", p_matrix.reset_index().rename(columns={"index": "Variable"}))
    pair_frame = pd.DataFrame(pairs)
    result.add("Pairs", pair_frame)
    hits = pair_frame[pair_frame["p"] < ALPHA].assign(size=lambda f: f[label].abs()).sort_values("size", ascending=False)
    for _, row in hits.head(6).iterrows():
        direction = "positive" if row[label] > 0 else "negative"
        result.interpretation.append(f"{row['Variable 1']} and {row['Variable 2']} have a {row['Strength']} {direction} correlation, {label}({row['N'] - 2}) = {bare(row[label])}, {fmt_p(row['p'])}.")
    if hits.empty:
        result.interpretation.append("No pair of variables is significantly correlated.")
    elif len(hits) > 6:
        result.interpretation.append(f"{len(hits) - 6} more significant pairs are in the Pairs table.")
    result.interpretation.append("Correlation shows association, not cause.")


def cmd_chisq(data, args, result):
    row_name, col_name = column(data, args.row), column(data, args.col)
    frame = data[[row_name, col_name]].dropna().astype(str)
    observed = pd.crosstab(frame[row_name], frame[col_name])
    if observed.shape[0] < 2 or observed.shape[1] < 2:
        raise ArgError("chi-square needs at least two categories in each variable")
    chi2, p, dof, expected = st.chi2_contingency(observed, correction=False)
    n = int(observed.to_numpy().sum())
    v = math.sqrt(chi2 / (n * (min(observed.shape) - 1)))
    expected = pd.DataFrame(expected, index=observed.index, columns=observed.columns)
    low_share = (expected.to_numpy() < 5).mean()
    tests = [{"Test": "Pearson chi-square", "Value": chi2, "df": dof, "p": p}]
    if observed.shape == (2, 2):
        yates, yates_p, _, _ = st.chi2_contingency(observed, correction=True)
        tests.append({"Test": "Continuity correction (Yates)", "Value": yates, "df": dof, "p": yates_p})
    if low_share > 0.2 or (expected.to_numpy() < 1).any():
        message = f"{low_share:.0%} of cells have expected counts below 5 (limit 20%)"
        if observed.shape == (2, 2):
            odds, fisher_p = st.fisher_exact(observed)
            tests.append({"Test": "Fisher's exact test", "Value": odds, "df": np.nan, "p": fisher_p})
            p_used, used = fisher_p, "Fisher's exact test"
            result.warnings.append(message + "; Fisher's exact test reported instead")
        else:
            p_used, used = p, "Pearson chi-square"
            result.warnings.append(message + "; merge sparse categories and rerun, the chi-square p-value is unreliable")
    else:
        p_used, used = p, "Pearson chi-square"
    tests.append({"Test": "Cramer's V", "Value": v, "df": np.nan, "p": np.nan})
    result.title = f"Chi-square test of independence: {row_name} x {col_name}"
    percent = observed.div(observed.sum(axis=1), axis=0) * 100
    result.add("Observed counts", observed.reset_index())
    result.add(f"Row percentages (% within {row_name})", percent.reset_index())
    result.add("Expected counts", expected.reset_index())
    result.add("Tests", pd.DataFrame(tests).astype({"df": "Int64"}))
    stats_text = f"chi-square({dof}, N = {n}) = {chi2:.2f}, {fmt_p(p)}, Cramer's V = {bare(v)}"
    if used != "Pearson chi-square":
        stats_text += f"; {used} {fmt_p(p_used)}"
    if significant(p_used):
        result.interpretation.append(f"{row_name} and {col_name} are significantly associated ({stats_text}), a {v_size(v, min(observed.shape) - 1)} association. Compare the row percentages to see where the groups differ.")
    else:
        result.interpretation.append(f"There is no significant association between {row_name} and {col_name} ({stats_text}).")


def cronbach_alpha(items):
    k = items.shape[1]
    return k / (k - 1) * (1 - items.var(ddof=1).sum() / items.sum(axis=1).var(ddof=1))


def cmd_reliability(data, args, result):
    names = columns(data, args.cols)
    if len(names) < 2:
        raise ArgError("reliability needs at least two items")
    items = pd.DataFrame({n: numeric(data, n) for n in names}).dropna()
    dropped = len(data) - len(items)
    if len(items) < 3:
        raise ArgError("fewer than three complete responses")
    if args.reverse:
        low = args.scale_min if args.scale_min is not None else items.min().min()
        high = args.scale_max if args.scale_max is not None else items.max().max()
        if args.scale_min is None or args.scale_max is None:
            result.lines.append(f"note: reverse-coded using the observed scale {low:g}-{high:g}; pass --scale-min/--scale-max if that is wrong")
        for name in columns(data, args.reverse):
            if name not in items:
                raise ArgError(f"{name!r} is not one of the --cols items")
            items[name] = low + high - items[name]
    k = len(names)
    alpha = cronbach_alpha(items)
    corr = items.corr().to_numpy()
    mean_r = corr[np.triu_indices(k, 1)].mean()
    standardized = k * mean_r / (1 + (k - 1) * mean_r)
    total = items.sum(axis=1)
    rows = []
    for name in names:
        rest = total - items[name]
        rows.append({"Item": name, "Mean": items[name].mean(), "SD": items[name].std(ddof=1),
                     "Corrected item-total r": items[name].corr(rest),
                     "Alpha if item deleted": cronbach_alpha(items.drop(columns=name)) if k > 2 else np.nan})
    item_table = pd.DataFrame(rows)
    result.title = f"Reliability (Cronbach's alpha): {k} items"
    result.add("Reliability statistics", pd.DataFrame([{"Cronbach's alpha": alpha, "Standardized alpha": standardized, "Items": k,
                                                        "N (complete)": len(items), "Excluded (missing)": dropped,
                                                        "Mean inter-item r": mean_r}]))
    result.add("Item-total statistics", item_table)
    negative = item_table.loc[item_table["Corrected item-total r"] < 0, "Item"].tolist()
    if negative:
        result.warnings.append(f"negative item-total correlation: {', '.join(negative)}; these look reverse-worded, rerun with --reverse")
    weak = item_table.loc[(item_table["Corrected item-total r"] >= 0) & (item_table["Corrected item-total r"] < 0.3), "Item"].tolist()
    if dropped:
        result.lines.append(f"note: {dropped} responses with a missing item were excluded (listwise)")
    result.interpretation.append(f"Cronbach's alpha for the {k} items is {bare(alpha, 3)} (n = {len(items)}), which is {alpha_word(alpha)} internal consistency (George and Mallery: .9 excellent, .8 good, .7 acceptable, .6 questionable, .5 poor).")
    better = item_table[item_table["Alpha if item deleted"] > alpha + 0.02]
    if len(better):
        listing = ", ".join(f"{r['Item']} (alpha {bare(r['Alpha if item deleted'], 3)})" for _, r in better.iterrows())
        result.interpretation.append(f"Removing these items would raise alpha: {listing}; drop an item only if its content also fits poorly.")
    if weak:
        result.interpretation.append(f"Items with weak item-total correlation (below .30): {', '.join(weak)}.")
    result.interpretation.append("Alpha shows that the items measure the same thing consistently; it is not evidence of validity.")


def cmd_flag(data, args, result, mixed):
    names = columns(data, args.cols)
    for name in names:
        numeric(data, name)
    ids = columns(data, args.id) if args.id else [c for c in data.columns if c not in names and not pd.api.types.is_numeric_dtype(data[c])][:2]
    marks = data[names]
    low = marks.le(args.below) if args.inclusive else marks.lt(args.below)
    hit = low.any(axis=1)
    rule = f"{'at or below' if args.inclusive else 'below'} {args.below:g}"
    flagged = data.loc[hit, ids + names].copy()
    flagged.insert(0, "Row", flagged.index)
    flagged["Low in"] = [", ".join(n for n in names if low.at[i, n]) for i in flagged.index]
    flagged["Count"] = low.loc[hit].sum(axis=1).astype(int).to_numpy()
    summary = pd.DataFrame([{"Column": n, "N": int(marks[n].notna().sum()), "Mean": marks[n].mean(),
                             f"Count {rule}": int(low[n].sum()),
                             "Percent": low[n].sum() / marks[n].notna().sum() * 100 if marks[n].notna().sum() else np.nan}
                            for n in names])
    odd = [{"Row": row, **{i: data.at[row, i] for i in ids}, "Column": n, "Value": value}
           for n in names for row, value in mixed.get(n, [])]
    result.title = f"Rows with any of {', '.join(names)} {rule}"
    result.add(f"Flagged rows ({len(flagged)})", flagged)
    result.add("Summary by column", summary)
    if odd:
        result.add("Entries that are not numbers (check by hand)", pd.DataFrame(odd))
        result.warnings.append(f"{len(odd)} entries are not numbers (e.g. {odd[0]['Value']!r} in row {odd[0]['Row']}); they were not compared, check them by hand")
    blanks = int(marks.isna().sum().sum()) - len(odd)
    if blanks:
        result.lines.append(f"note: {blanks} blank cells were not checked")
    result.interpretation.append(f"{len(flagged)} of {len(data)} rows ({len(flagged) / len(data):.0%}) have at least one value {rule}; row numbers match the sheet.")
    if len(flagged):
        worst = summary.sort_values(f"Count {rule}", ascending=False).iloc[0]
        result.interpretation.append(f"{worst['Column']} has the most ({int(worst[f'Count {rule}'])}, {worst['Percent']:.0f}% of those with a value).")
        several = int((flagged["Count"] > 1).sum())
        if several:
            result.interpretation.append(f"{several} rows are low in more than one column and are the first to check.")


def cmd_compare(data, args, result):
    groups = columns(data, args.group)
    names = columns(data, args.cols) if args.cols else [c for c in numeric_columns(data) if c not in groups]
    for name in names:
        numeric(data, name)
    chosen = [s.strip() for s in args.stats.split(",") if s.strip()]
    unknown = [s for s in chosen if s not in AGGREGATES]
    if unknown:
        raise ArgError(f"unknown --stats {', '.join(unknown)}; choose from {', '.join(AGGREGATES)}")
    grouped = data.groupby(groups, sort=True, dropna=False)[names].agg([AGGREGATES[s] for s in chosen])
    grouped.columns = [f"{name} {stat}" for name in names for stat in chosen]
    table = grouped.reset_index()
    if args.total:
        overall = data[names].agg([AGGREGATES[s] for s in chosen])
        total_row = {g: ("Total" if i == 0 else "") for i, g in enumerate(groups)}
        total_row.update({f"{name} {stat}": overall.loc[AGGREGATES[stat], name] for name in names for stat in chosen})
        table = pd.concat([table, pd.DataFrame([total_row])], ignore_index=True)
    result.title = f"Comparison of {', '.join(names)} by {' and '.join(groups)}"
    counts_cols = [f"{name} count" for name in names if "count" in chosen]
    result.add("Group summary", table.astype({c: "Int64" for c in counts_cols}))
    key_stat = "mean" if "mean" in chosen else "sum" if "sum" in chosen else chosen[0]
    body = grouped.reset_index()
    label = body[groups].astype(str).agg(" / ".join, axis=1)
    for name in names[:6]:
        values = body[f"{name} {key_stat}"]
        if values.notna().sum() < 2:
            continue
        top, bottom = values.idxmax(), values.idxmin()
        gap = values[top] - values[bottom]
        share = f" ({gap / values[bottom]:.0%} more)" if values[bottom] > 0 else ""
        result.interpretation.append(f"{name} ({key_stat}) is highest for {label[top]} ({fmt(values[top])}) and lowest for {label[bottom]} ({fmt(values[bottom])}), a gap of {fmt(gap)}{share}.")
    counts = data.groupby(groups, dropna=False).size()
    if (counts < 2).any() and "mean" in chosen:
        result.lines.append("note: some groups have a single row, so their mean is that one value")


def cell_value(value, column_name):
    if value is None or value is pd.NA:
        return None
    if isinstance(value, (np.bool_, bool)):
        return "yes" if value else "no"
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        if math.isnan(value) or math.isinf(value):
            return None
        if column_name in ("p", "Spearman p", "Robust p (HC3)", "p-adj") and value < 0.001:
            return "< .001"
        return float(value)
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime()
    return value


def save_xlsx(result, out, sheet_name):
    workbook = load_workbook(out) if out.exists() else Workbook()
    if not out.exists():
        workbook.remove(workbook.active)
    if sheet_name in workbook.sheetnames:
        index = workbook.sheetnames.index(sheet_name)
        workbook.remove(workbook[sheet_name])
        sheet = workbook.create_sheet(sheet_name, index)
    else:
        sheet = workbook.create_sheet(sheet_name)
    bold = Font(name="Arial", bold=True)
    plain = Font(name="Arial")
    sheet.cell(row=1, column=1, value=result.title).font = Font(name="Arial", bold=True, size=12)
    row = 3
    widths = {}
    for title, frame in result.tables:
        sheet.cell(row=row, column=1, value=title).font = bold
        row += 1
        for c, name in enumerate(frame.columns, 1):
            sheet.cell(row=row, column=c, value=str(name)).font = bold
            widths[c] = max(widths.get(c, 8), len(str(name)) + 2)
        for record in frame.itertuples(index=False):
            row += 1
            for c, (name, value) in enumerate(zip(frame.columns, record), 1):
                cell = sheet.cell(row=row, column=c, value=cell_value(value, name))
                cell.font = plain
                if isinstance(cell.value, float):
                    cell.number_format = "0.000" if abs(cell.value) < 1000 else "#,##0.00"
                widths[c] = max(widths.get(c, 8), min(len(str(cell.value)) + 2, 40))
        row += 2
    for heading, lines in (("Warnings", result.warnings), ("Interpretation", [" ".join(result.interpretation)])):
        if not any(lines):
            continue
        sheet.cell(row=row, column=1, value=heading).font = bold
        for line in lines:
            row += 1
            cell = sheet.cell(row=row, column=1, value=line)
            cell.font = plain
            cell.alignment = Alignment(wrap_text=False)
        row += 2
    for c, width in widths.items():
        sheet.column_dimensions[sheet.cell(row=1, column=c).column_letter].width = width
    workbook.save(out)


def save_csv(result, out):
    with out.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow([result.title])
        for title, frame in result.tables:
            writer.writerow([])
            writer.writerow([title])
            writer.writerow(list(frame.columns))
            for record in frame.itertuples(index=False):
                writer.writerow(["" if (v := cell_value(value, name)) is None else v for name, value in zip(frame.columns, record)])
        writer.writerow([])
        writer.writerow(["Interpretation", " ".join(result.interpretation)])
        for warning in result.warnings:
            writer.writerow(["Warning", warning])


def show(frame, limit=25):
    shown = frame.head(limit).copy()
    for name in shown.columns:
        if pd.api.types.is_float_dtype(shown[name]):
            shown[name] = shown[name].map(lambda v: "" if pd.isna(v) else (apa_p(v) if name in ("p", "Spearman p", "Robust p (HC3)") else f"{v:,.3f}"))
    text = shown.astype(object).where(shown.notna(), "").to_string(index=False)
    return text + (f"\n... {len(frame) - limit} more rows in the results file" if len(frame) > limit else "")


def report(result, out, sheet_name):
    print(result.title)
    for title, frame in result.tables:
        print(f"\n{title}:")
        print(show(frame))
    for line in result.lines:
        print(line)
    if result.warnings:
        print("\nWarnings:")
        for warning in result.warnings:
            print(f"- {warning}")
    print("\nInterpretation: " + " ".join(result.interpretation))
    print(f"\nresults: {out}" + ("" if out.suffix.lower() == ".csv" else f" [sheet {sheet_name}]"))


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("input")
    common.add_argument("--sheet", help="sheet to read (default: the first)")
    common.add_argument("--header-row", type=int, help="1-based row holding the column names, when detection is wrong")
    common.add_argument("--out", default=DEFAULT_OUT, help=f"results .xlsx or .csv (default {DEFAULT_OUT})")
    common.add_argument("--out-sheet", help="results sheet name (default: the subcommand)")
    parser = Parser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True, parser_class=Parser)

    p = sub.add_parser("describe", parents=[common], help="descriptive statistics and frequencies")
    p.add_argument("--cols", nargs="+")
    p.add_argument("--group")

    p = sub.add_parser("ttest", parents=[common], help="independent, Welch, paired or one-sample t-test")
    p.add_argument("--dv")
    p.add_argument("--group")
    p.add_argument("--groups", nargs=2, help="the two levels of --group to compare")
    p.add_argument("--cols", nargs="+", help="BEFORE AFTER for paired; one column with --mu for one-sample")
    p.add_argument("--mu", type=float)
    p.add_argument("--type", choices=["auto", "student", "welch", "paired"], default="auto")

    p = sub.add_parser("anova", parents=[common], help="one-way or two-way ANOVA with Tukey post-hoc")
    p.add_argument("--dv", required=True)
    p.add_argument("--iv", nargs="+", required=True)
    p.add_argument("--ss", type=int, choices=[2, 3], default=3, help="sums of squares type (3 matches SPSS)")

    p = sub.add_parser("regression", parents=[common], help="OLS regression with VIF and residual checks")
    p.add_argument("--dv", required=True)
    p.add_argument("--iv", nargs="+", required=True)

    p = sub.add_parser("correlation", parents=[common], help="Pearson or Spearman correlation matrix with p-values")
    p.add_argument("--cols", nargs="+")
    p.add_argument("--method", choices=["pearson", "spearman"], default="pearson")

    p = sub.add_parser("chisq", parents=[common], help="chi-square test of independence")
    p.add_argument("--row", required=True)
    p.add_argument("--col", required=True)

    p = sub.add_parser("reliability", parents=[common], help="Cronbach's alpha with item-total statistics")
    p.add_argument("--cols", nargs="+", required=True)
    p.add_argument("--reverse", nargs="+", help="items to reverse-code before scoring")
    p.add_argument("--scale-min", type=float)
    p.add_argument("--scale-max", type=float)

    p = sub.add_parser("flag", parents=[common], help="rows where any of the columns is below a threshold")
    p.add_argument("--cols", nargs="+", required=True)
    p.add_argument("--below", type=float, required=True)
    p.add_argument("--inclusive", action="store_true", help="flag values equal to the threshold too")
    p.add_argument("--id", nargs="+", help="identifying columns to show (default: the first two text columns)")

    p = sub.add_parser("compare", parents=[common], help="summary table by group")
    p.add_argument("--group", nargs="+", required=True)
    p.add_argument("--cols", nargs="+")
    p.add_argument("--stats", default="count,mean,sd,min,max", help=f"comma list from {','.join(AGGREGATES)}")
    p.add_argument("--total", action="store_true", help="add an overall row")
    return parser


COMMANDS = {"describe": cmd_describe, "ttest": cmd_ttest, "anova": cmd_anova, "regression": cmd_regression,
            "correlation": cmd_correlation, "chisq": cmd_chisq, "reliability": cmd_reliability, "compare": cmd_compare}


def main():
    args = build_parser().parse_args()
    try:
        table = load(args.input, args.sheet, args.header_row)
        result = Result(title=args.command)
        if args.command == "flag":
            cmd_flag(table.data, args, result, table.mixed)
        else:
            COMMANDS[args.command](table.data, args, result)
    except (ArgError, DataError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    for note in table.notes:
        result.lines.insert(0, f"note: {note}")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet_name = (args.out_sheet or args.command)[:31]
    if out.suffix.lower() == ".csv":
        save_csv(result, out)
    else:
        save_xlsx(result, out, sheet_name)
    report(result, out, sheet_name)
    return 2 if result.warnings else 0


if __name__ == "__main__":
    sys.exit(main())
