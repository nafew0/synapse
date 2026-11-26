"""The infographic kinds deck.py will offer, and the folder or deck names that already say which one."""

import re

KINDS = [
    ("process", "p", "steps or stages in order, arrows, chevrons"),
    ("cycle", "c", "stages that loop back to the start"),
    ("timeline", "t", "dates, roadmap, milestones, Gantt, 30-60-90"),
    ("funnel", "f", "stages that narrow"),
    ("pyramid", "y", "levels or a hierarchy that widens downward"),
    ("matrix", "m", "2x2, SWOT, PESTEL, RACI grids"),
    ("comparison", "v", "side by side, pros and cons, pricing"),
    ("hub", "h", "a centre with spokes, mind map, network"),
    ("concentric", "o", "rings, target, Venn, TAM SAM SOM"),
    ("puzzle", "z", "puzzle pieces"),
    ("kpi", "k", "headline figures, percentage rings, dashboards"),
    ("chart", "g", "a real chart: bars, lines, pies"),
    ("table", "b", "a table"),
    ("map", "a", "a country or world map"),
    ("org", "r", "team, org chart, people structure"),
    ("illustration", "i", "people, scenes or objects to decorate a slide"),
    ("cover", "s", "title, agenda, section or closing design"),
    ("skip", "x", "not useful"),
]
KIND_NAMES = [name for name, _, _ in KINDS]

"""Folder or deck names that name a kind. First match wins, so specific names come first."""
NAMED = [
    ("timeline", r"timeline|roadmap|milestone|gantt|schedule|calendar|30 60 90"),
    ("cycle", r"cycle"),
    ("funnel", r"funnel"),
    ("pyramid", r"pyramid|hierarchy"),
    ("matrix", r"swot|pestel|matrix|raci|rapid"),
    ("comparison", r"comparison|pricing"),
    ("hub", r"mind map|bubble map|network"),
    ("concentric", r"concentric|circle|venn|tam sam som|target market"),
    ("puzzle", r"puzzle"),
    ("map", r"\bmaps?\b|world|europe|asia|africa|america|oceania"),
    ("kpi", r"dashboard|kpi|data analysis|annual report|demographic|smile rating|project status|big data|budget"),
    ("org", r"\bteam|teamwork|business people"),
    ("process", r"process|arrow"),
    ("cover", r"\btitle\b|agenda|thank you|question|introduction|summary|cover|tables of content"),
]
"""Names that look like a kind but hold a mix; their slides are guessed one by one."""
MIXED = re.compile(r"^(charts|smartart|charts, data distribution|mixed|empathy map)\b", re.I)


def named_kind(name):
    if MIXED.search(name):
        return None
    for kind, pattern in NAMED:
        if re.search(pattern, name, re.I):
            return kind
    return None
