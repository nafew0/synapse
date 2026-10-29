"""Static check of a LaTeX document before delivery. It does not compile anything.

Usage: python check_tex.py MAIN.tex [--bib FILE.bib ...] [--engine pdflatex|xelatex|lualatex]
                           [--snippet] [--strict]

Reads MAIN.tex and the local files it \\input{}s or \\include{}s, skipping comments and the bodies
of verbatim, lstlisting and minted environments. Reports errors (things that stop or break a
compile) and warnings (style and typography), grouped by severity with file and line numbers.

--snippet  the file is a fragment (a chapter for \\include, a table): no \\documentclass needed,
           package checks skipped, references to labels elsewhere are warnings.
--strict   warnings also fail the check.

Exit codes: 0 clean, 2 defects listed in the report, 1 bad arguments.
"""
import argparse
import bisect
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

VERBATIM_ENVS = {
    'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim', 'lstlisting',
    'minted', 'comment', 'filecontents', 'filecontents*', 'semiverbatim',
}
FRAGILE_ENVS = VERBATIM_ENVS - {'comment', 'filecontents', 'filecontents*'}
MULTIROW_MATH_ENVS = {
    'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*',
    'alignat', 'alignat*', 'eqnarray', 'eqnarray*', 'IEEEeqnarray', 'IEEEeqnarray*',
}
MATH_ENVS = MULTIROW_MATH_ENVS | {
    'equation', 'equation*', 'displaymath', 'math', 'dmath', 'dmath*', 'subequations*',
}
ALIGN_ENVS = MULTIROW_MATH_ENVS | {
    'tabular', 'tabular*', 'tabularx', 'tabulary', 'longtable', 'longtable*', 'xltabular', 'array',
    'supertabular', 'tabu', 'longtabu', 'NiceTabular', 'NiceArray', 'tblr', 'longtblr', 'talltblr',
    'split', 'aligned', 'alignedat', 'gathered', 'cases', 'cases*', 'dcases', 'rcases', 'numcases',
    'subnumcases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix',
    'tikzcd', 'empheq', 'blockarray', 'block', 'IEEEeqnarraybox',
}
TABULAR_SPEC_ARGS = {
    'tabular': 1, 'tabular*': 2, 'tabularx': 2, 'tabulary': 2, 'xltabular': 2, 'longtable': 1,
    'array': 1, 'supertabular': 1,
}
NO_ESCAPE_ENVS = {'tikzpicture', 'tikzcd', 'pgfpicture', 'circuitikz', 'forest', 'axis'}
FLOAT_ENVS = {
    'figure', 'figure*', 'table', 'table*', 'subfigure', 'subtable', 'wrapfigure', 'wraptable',
    'sidewaysfigure', 'sidewaystable', 'SCfigure', 'SCtable',
}
LABEL_OWNER_ENVS = MATH_ENVS | {'enumerate', 'itemize', 'description', 'frame'}
THEOREM_NAMES = {
    'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'remark', 'example', 'problem',
    'exercise', 'conjecture', 'claim', 'note', 'assumption', 'hypothesis',
}
DELIMITER_PREFIXES = {
    'left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
    'biggl', 'biggr', 'Biggl', 'Biggr', 'bigm', 'Bigm',
}
TEXT_IN_MATH = {
    'text', 'mbox', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'textup', 'textnormal',
    'intertext', 'shortintertext', 'hbox', 'textsc', 'textsl', 'emph',
}
REF_CMDS = {'ref', 'eqref', 'pageref', 'cref', 'Cref', 'autoref', 'nameref', 'vref', 'Vref',
            'cpageref', 'labelcref', 'crefrange', 'Crefrange'}
TILDE_REF_CMDS = {'ref', 'eqref', 'pageref'}
INPUT_CMDS = {'input', 'include', 'subfile'}
RAW_ARG_CMDS = {
    'usepackage': 1, 'RequirePackage': 1, 'documentclass': 1, 'url': 1, 'href': 1, 'path': 1,
    'nolinkurl': 1, 'includegraphics': 1, 'includeonly': 1, 'graphicspath': 1, 'bibliography': 1,
    'bibliographystyle': 1, 'addbibresource': 1, 'lstinputlisting': 1, 'inputminted': 2,
    'hyperlink': 1, 'hypertarget': 1, 'hyperref': 0, 'color': 1, 'textcolor': 1, 'colorbox': 1,
    'pagecolor': 1, 'rowcolor': 1, 'cellcolor': 1, 'pagestyle': 1, 'thispagestyle': 1,
    'pagenumbering': 1, 'setcounter': 1, 'addtocounter': 1, 'stepcounter': 1, 'refstepcounter': 1,
    'value': 1, 'arabic': 1, 'roman': 1, 'alph': 1, 'Alph': 1, 'Roman': 1, 'geometry': 1,
    'pgfkeys': 1, 'usetikzlibrary': 1, 'usepgfplotslibrary': 1, 'tcbuselibrary': 1,
    'mode': 0, 'only': 0, 'externaldocument': 1, 'cline': 1, 'cmidrule': 1, 'hhline': 1,
    'printbibliography': 0, 'printanswers': 0, 'resizebox': 2, 'scalebox': 1,
}
RAW_ARG_PATTERN = re.compile(r'(?!(?:display|text|script|scriptscript)style$)'
                             r'(?:[A-Za-z]*setup|[A-Za-z]*set|set[A-Za-z]+|use[A-Za-z]+|'
                             r'define[A-Za-z]*|[A-Za-z]*style|[A-Za-z]*theme)$')
DEF_GROUPS = {
    'newcommand': 2, 'renewcommand': 2, 'providecommand': 2, 'DeclareRobustCommand': 2,
    'NewDocumentCommand': 3, 'RenewDocumentCommand': 3, 'ProvideDocumentCommand': 3,
    'DeclareDocumentCommand': 3, 'newenvironment': 3, 'renewenvironment': 3,
    'NewDocumentEnvironment': 4, 'RenewDocumentEnvironment': 4, 'DeclareMathOperator': 2,
    'DeclarePairedDelimiter': 3, 'newtheorem': 2, 'declaretheorem': 1, 'newcolumntype': 2,
    'newtcolorbox': 2, 'newunicodechar': 2, 'newlist': 3, 'newcounter': 1, 'newlength': 1,
    'newif': 0, 'crefname': 3, 'Crefname': 3, 'newfontfamily': 2, 'theoremstyle': 1,
    'newgeometry': 1, 'newtheoremstyle': 9,
}
TEX_DEFS = {'def', 'gdef', 'edef', 'xdef'}
ENV_DEFINERS = {'newenvironment', 'renewenvironment', 'NewDocumentEnvironment',
                'RenewDocumentEnvironment', 'newtheorem', 'declaretheorem', 'newtcolorbox',
                'newlist'}

DEPRECATED = {
    'bf': r'\textbf{...} or \bfseries', 'it': r'\textit{...} or \itshape',
    'rm': r'\textrm{...} or \mathrm{...}', 'sc': r'\textsc{...}', 'tt': r'\texttt{...}',
    'sf': r'\textsf{...}', 'sl': r'\textsl{...}', 'cal': r'\mathcal{...}',
    'over': r'\frac{...}{...}', 'centerline': r'\centering or a center environment',
}
MATHJAX_ONLY = {'bbox', 'require', 'cssId', 'class', 'style', 'toggle'}

CMD_PACKAGES = {
    **dict.fromkeys(['text', 'eqref', 'DeclareMathOperator', 'operatorname', 'dfrac', 'tfrac',
                     'binom', 'dbinom', 'tbinom', 'boxed', 'intertext', 'substack', 'iint',
                     'iiint', 'numberwithin', 'tag', 'xrightarrow', 'xleftarrow', 'overset',
                     'underset', 'cfrac', 'genfrac', 'allowdisplaybreaks', 'notag'],
                    ('amsmath',)),
    **dict.fromkeys(['mathbb', 'mathfrak'], ('amssymb', 'amsfonts')),
    **dict.fromkeys(['checkmark', 'therefore', 'because', 'leqslant', 'geqslant', 'varnothing',
                     'blacksquare', 'nexists', 'lesssim', 'gtrsim'], ('amssymb',)),
    **dict.fromkeys(['qed', 'qedhere', 'theoremstyle', 'swapnumbers'], ('amsthm', 'ntheorem')),
    **dict.fromkeys(['includegraphics'], ('graphicx', 'graphics')),
    **dict.fromkeys(['rotatebox', 'scalebox', 'resizebox'], ('graphicx', 'graphics')),
    **dict.fromkeys(['toprule', 'midrule', 'bottomrule', 'cmidrule', 'addlinespace'],
                    ('booktabs',)),
    **dict.fromkeys(['SI', 'si', 'num', 'unit', 'ang', 'SIrange', 'numrange', 'qtyrange',
                     'sisetup', 'tablenum'], ('siunitx',)),
    'qty': ('siunitx', 'physics'),
    'url': ('url', 'hyperref', 'xurl'),
    **dict.fromkeys(['href', 'hypersetup', 'autoref', 'hyperlink', 'hypertarget', 'hyperref',
                     'texorpdfstring'], ('hyperref',)),
    **dict.fromkeys(['cref', 'Cref', 'crefname', 'Crefname', 'cpageref', 'crefrange'],
                    ('cleveref',)),
    **dict.fromkeys(['lstinline', 'lstinputlisting', 'lstset', 'lstdefinestyle',
                     'lstdefinelanguage'], ('listings',)),
    **dict.fromkeys(['mintinline', 'inputminted', 'setminted', 'usemintedstyle'], ('minted',)),
    **dict.fromkeys(['textcolor', 'color', 'colorbox', 'fcolorbox', 'definecolor', 'pagecolor'],
                    ('xcolor', 'color')),
    **dict.fromkeys(['rowcolor', 'cellcolor', 'columncolor'], ('colortbl',)),
    **dict.fromkeys(['tikz', 'usetikzlibrary', 'tikzset'], ('tikz',)),
    'pgfplotsset': ('pgfplots',),
    'multirow': ('multirow',),
    **dict.fromkeys(['subcaption', 'subcaptionbox', 'subref'], ('subcaption',)),
    'captionof': ('caption', 'capt-of'),
    'captionsetup': ('caption',),
    **dict.fromkeys(['geometry', 'newgeometry'], ('geometry',)),
    'bm': ('bm',),
    **dict.fromkeys(['cancel', 'bcancel', 'xcancel', 'cancelto'], ('cancel',)),
    'ce': ('mhchem', 'chemformula'),
    **dict.fromkeys(['hl', 'ul', 'st', 'so'], ('soul',)),
    'uline': ('ulem',),
    **dict.fromkeys(['setmainfont', 'setsansfont', 'setmonofont', 'newfontfamily',
                     'defaultfontfeatures'], ('fontspec',)),
    'FloatBarrier': ('placeins',),
    **dict.fromkeys(['printbibliography', 'addbibresource', 'parencite', 'textcite', 'autocite',
                     'footcite', 'smartcite'], ('biblatex',)),
    **dict.fromkeys(['citep', 'citet', 'citealp', 'citealt'], ('natbib', 'biblatex')),
    **dict.fromkeys(['doublespacing', 'onehalfspacing', 'singlespacing', 'setstretch'],
                    ('setspace',)),
    'enquote': ('csquotes',),
    'mathscr': ('mathrsfs',),
    **dict.fromkeys(['coloneqq', 'DeclarePairedDelimiter', 'mathclap', 'prescript'],
                    ('mathtools',)),
    **dict.fromkeys(['dv', 'pdv', 'abs', 'norm', 'ket', 'bra', 'braket'], ('physics',)),
    'lipsum': ('lipsum',),
    'todo': ('todonotes',),
    **dict.fromkeys(['fancyhead', 'fancyfoot', 'fancyhf'], ('fancyhdr',)),
    'titleformat': ('titlesec',),
    'newunicodechar': ('newunicodechar',),
}
ENV_PACKAGES = {
    **dict.fromkeys(['align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'flalign',
                     'flalign*', 'alignat', 'alignat*', 'aligned', 'alignedat', 'gathered',
                     'cases', 'split', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix',
                     'Vmatrix', 'smallmatrix', 'subequations'], ('amsmath',)),
    'proof': ('amsthm', 'ntheorem'),
    'lstlisting': ('listings',),
    'minted': ('minted',),
    'tikzpicture': ('tikz',),
    'axis': ('pgfplots',),
    'longtable': ('longtable',),
    'tabularx': ('tabularx',),
    'xltabular': ('xltabular',),
    **dict.fromkeys(['subfigure', 'subtable'], ('subcaption',)),
    'multicols': ('multicol',),
    'wrapfigure': ('wrapfig',),
    'algorithm': ('algorithm', 'algorithm2e'),
    'algorithmic': ('algpseudocode', 'algorithmic', 'algorithmicx'),
    'Verbatim': ('fancyvrb',),
    'comment': ('comment', 'verbatim'),
    **dict.fromkeys(['dcases', 'rcases'], ('mathtools',)),
    'tcolorbox': ('tcolorbox',),
    'landscape': ('pdflscape', 'lscape'),
    **dict.fromkeys(['sidewaysfigure', 'sidewaystable'], ('rotating',)),
    'tblr': ('tabularray',),
}
IMPLIED = {
    'mathtools': {'amsmath'}, 'amssymb': {'amsfonts'}, 'empheq': {'mathtools'},
    'tikz': {'pgf'}, 'pgf': {'xcolor', 'graphicx'}, 'pgfplots': {'tikz'}, 'tcolorbox': {'pgf'},
    'todonotes': {'tikz'}, 'circuitikz': {'tikz'}, 'forest': {'tikz'}, 'tikz-cd': {'tikz'},
    'subcaption': {'caption'}, 'hyperref': {'url'}, 'bookmark': {'hyperref'},
    'minted': {'xcolor', 'fancyvrb'}, 'xltabular': {'longtable', 'tabularx'},
    'adjustbox': {'graphicx'}, 'epsfig': {'graphicx'}, 'graphicx': {'graphics'},
    'unicode-math': {'fontspec'}, 'polyglossia': {'fontspec'}, 'xeCJK': {'fontspec'},
    'colortbl': {'color', 'array'}, 'xcolor': {'color'}, 'xurl': {'url'},
    'physics': {'amsmath'}, 'algpseudocode': {'algorithmicx'}, 'nicematrix': {'pgf', 'amsmath'},
    'tabularx': {'array'}, 'amsart': {'amsmath'},
}
CLASS_PACKAGES = {
    **dict.fromkeys(['article', 'report', 'book', 'letter', 'proc', 'minimal', 'exam', 'scrartcl',
                     'scrreprt', 'scrbook', 'scrlttr2', 'IEEEtran'], set()),
    **dict.fromkeys(['amsart', 'amsbook', 'amsproc'], {'amsmath', 'amsthm', 'amsfonts'}),
    'beamer': {'amsmath', 'amsthm', 'amssymb', 'graphicx', 'xcolor', 'hyperref', 'pgf'},
}
CLASS_THEOREMS = {'beamer': {'theorem', 'lemma', 'corollary', 'definition', 'example', 'fact',
                             'proof'}}
AFTER_HYPERREF_OK = {
    'cleveref', 'bookmark', 'hypcap', 'glossaries', 'glossaries-extra', 'algorithm', 'hyperxmp',
    'orcidlink', 'doi', 'uri', 'autonum', 'xurl', 'url', 'nameref', 'zref-clever',
}
MATH_FONT_PACKAGES = {'newtxmath', 'newpxmath', 'txfonts', 'pxfonts', 'stix', 'stix2', 'kpfonts',
                      'fourier', 'unicode-math', 'mathabx', 'lucimatx', 'mtpro2'}
SCRIPTS = [
    ('Sinhala', 0x0D80, 0x0DFF, 'Noto Serif Sinhala'),
    ('Tamil', 0x0B80, 0x0BFF, 'Noto Serif Tamil'),
    ('Bengali', 0x0980, 0x09FF, 'Noto Serif Bengali'),
    ('Devanagari', 0x0900, 0x097F, 'Noto Serif Devanagari'),
    ('Malayalam', 0x0D00, 0x0D7F, 'Noto Serif Malayalam'),
    ('Telugu', 0x0C00, 0x0C7F, 'Noto Serif Telugu'),
    ('Gujarati', 0x0A80, 0x0AFF, 'Noto Serif Gujarati'),
    ('Gurmukhi', 0x0A00, 0x0A7F, 'Noto Serif Gurmukhi'),
    ('Arabic', 0x0600, 0x06FF, 'Amiri'),
    ('Hebrew', 0x0590, 0x05FF, 'Noto Serif Hebrew'),
    ('Thai', 0x0E00, 0x0E7F, 'Noto Serif Thai'),
    ('Chinese or Japanese', 0x4E00, 0x9FFF, 'Noto Serif CJK SC'),
    ('Korean', 0xAC00, 0xD7AF, 'Noto Serif CJK KR'),
]
PDFTEX_UNSAFE = [(0x0370, 0x03FF), (0x2190, 0x21FF), (0x2200, 0x22FF)]
UNICODE_PACKAGES = {'fontspec', 'unicode-math', 'polyglossia', 'xeCJK'}
GREEK_PACKAGES = {'textgreek', 'alphabeta', 'newunicodechar', 'upgreek'}
FONT_COMMANDS = {'setmainfont', 'setsansfont', 'newfontfamily', 'babelfont', 'setotherlanguage',
                 'setmainlanguage', 'setCJKmainfont', 'fontspec'}

TOKEN = re.compile(r'''
    (?P<cmd>\\(?:[A-Za-z][A-Za-z@]*\*?|[^A-Za-z]))
  | (?P<open>\{) | (?P<close>\})
  | (?P<dollar>\$\$?)
  | (?P<par>\n[ \t]*\n(?:[ \t]*\n)*)
  | (?P<fence>^[ \t]*```)
  | (?P<char>[&\#_"])
  | (?P<dots>\.\.\.)
  | (?P<range>(?<![\w.\-])\d+-\d+(?![\w\-]))
  | (?P<bold>\*\*[^\s*][^*\n]*\*\*)
''', re.X | re.M)
ARG = re.compile(r'[ \t]*\n?[ \t]*\{')
NAME_ARG = re.compile(r'\s*\{([^{}]*)\}')
BLANK = '\x00'
ENGINE_NAMES = {'pdflatex': 'pdfLaTeX', 'xelatex': 'XeLaTeX', 'lualatex': 'LuaLaTeX'}


class UsageError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f'error: {message}', file=sys.stderr)
        sys.exit(1)


@dataclass
class Source:
    path: Path
    name: str
    text: str
    newlines: list
    comments: list
    percent_lines: list

    def line(self, offset):
        return bisect.bisect_right(self.newlines, offset - 1) + 1


@dataclass
class Env:
    name: str
    file: str
    line: int
    opts: str
    braces: int
    modes: int
    caption_seen: bool = False
    fragile_reported: bool = False


@dataclass
class Mode:
    kind: str
    file: str = ''
    line: int = 0
    env: str = ''
    lr: int = 0
    lr_line: int = 0


@dataclass
class Brace:
    file: str
    line: int
    modes: int
    pushed: bool


@dataclass
class Question:
    file: str
    line: int
    marks: bool
    part_marks: bool = False


@dataclass
class Findings:
    items: dict = field(default_factory=dict)

    def add(self, severity, file, line, message):
        self.items.setdefault((severity, file, message), []).append(line)

    def lines(self, severity):
        found = [(file, sorted(set(lines)), message)
                 for (sev, file, message), lines in self.items.items() if sev == severity]
        found.sort(key=lambda item: (item[0], item[1][0]))
        return [f'  {file}:{format_lines(lines)}: {message}' for file, lines, message in found]

    def count(self, severity):
        return sum(1 for (sev, _, _) in self.items if sev == severity)


def format_lines(lines):
    shown = ', '.join(str(n) for n in lines[:8])
    return shown + (f' (+{len(lines) - 8} more)' if len(lines) > 8 else '')


def comment_start(line):
    i = 0
    while i < len(line):
        if line[i] == '\\':
            i += 2
            continue
        if line[i] == '%':
            return i
        i += 1
    return -1


def mask(line, start, end):
    return line[:start] + BLANK * (end - start) + line[end:]


def mask_inline_verbatim(line):
    for m in re.finditer(r'\\(?:url|path|nolinkurl|href)\s*\{([^{}\n]*)\}', line):
        line = mask(line, m.start(1), m.end(1))
    pos = 0
    while True:
        m = re.compile(r'\\(verb|lstinline|mintinline)\*?').search(line, pos)
        if not m:
            return line
        i = m.end()
        if m.group(1) == 'mintinline':
            lang = re.compile(r'\{[^{}]*\}').match(line, i)
            i = lang.end() if lang else i
        if m.group(1) == 'lstinline':
            opt = re.compile(r'\[[^\]]*\]').match(line, i)
            i = opt.end() if opt else i
        if i >= len(line):
            return line
        close = '}' if line[i] == '{' else line[i]
        end = line.find(close, i + 1)
        end = len(line) - 1 if end < 0 else end
        line = mask(line, i, end + 1)
        pos = end + 1


def prepare(path, name):
    raw = path.read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n')
    out, comments, percent_lines = [], [], []
    verbatim = None
    for number, line in enumerate(raw.split('\n'), 1):
        if verbatim:
            end = re.search(r'\\end\s*\{' + re.escape(verbatim) + r'\}', line)
            if not end:
                out.append(BLANK)
                continue
            line = BLANK * end.start() + line[end.start():]
            verbatim = None
        line = mask_inline_verbatim(line)
        cut = comment_start(line)
        code = line
        if cut >= 0:
            comments.append((number, line[cut + 1:]))
            code = line[:cut]
            if cut > 0 and line[cut - 1].isdigit():
                percent_lines.append(number)
            if not code.strip():
                code = BLANK
        begin = re.search(r'\\begin\s*\{(' + '|'.join(re.escape(e) for e in VERBATIM_ENVS)
                          + r')\}(\[[^\]]*\])?(\{[^{}]*\})?', code)
        if begin:
            name_ = begin.group(1)
            rest = code[begin.end():]
            end = re.search(r'\\end\s*\{' + re.escape(name_) + r'\}', rest)
            if end:
                code = code[:begin.end()] + BLANK * end.start() + rest[end.start():]
            else:
                code = code[:begin.end()] + BLANK * len(rest)
                verbatim = name_
        out.append(code)
    text = '\n'.join(out)
    newlines = [i for i, c in enumerate(text) if c == '\n']
    return Source(path, name, text, newlines, comments, percent_lines)


def group_end(text, pos):
    depth = 0
    i = pos
    while i < len(text):
        c = text[i]
        if c == '\\':
            i += 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def bracket_end(text, pos):
    depth = 0
    i = pos + 1
    while i < len(text):
        c = text[i]
        if c == '\\':
            i += 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        elif c == ']' and depth <= 0:
            return i + 1
        elif c == '\n' and re.match(r'\n[ \t]*\n', text[i:i + 40]):
            return None
        i += 1
    return None


def split_keys(value):
    return [key.strip() for key in value.replace(BLANK, '').split(',') if key.strip()]


def parse_bib(path):
    keys = {}
    text = path.read_text(encoding='utf-8', errors='replace')
    for m in re.finditer(r'@\s*(\w+)\s*[{(]\s*([^,\s{}()]+)\s*,', text):
        if m.group(1).lower() in {'string', 'comment', 'preamble'}:
            continue
        line = text.count('\n', 0, m.start()) + 1
        keys.setdefault(m.group(2), []).append(line)
    return keys


def package_closure(packages):
    found = set(packages)
    pending = list(found)
    while pending:
        for implied in IMPLIED.get(pending.pop(), ()):
            if implied not in found:
                found.add(implied)
                pending.append(implied)
    return found


def scan_definitions(path):
    text = re.sub(r'(?m)(?<!\\)%.*$', '', path.read_text(encoding='utf-8', errors='replace'))
    packages = {name.strip() for m in re.finditer(
        r'\\(?:RequirePackage|usepackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}', text)
        for name in m.group(1).split(',') if name.strip()}
    base = re.search(r'\\LoadClass(?:WithOptions)?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}', text)
    commands = set(re.findall(
        r'\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|let|'
        r'DeclareMathOperator|NewDocumentCommand)\*?\s*\{?\\([A-Za-z@]+)', text))
    envs = set(re.findall(r'\\(?:newenvironment|renewenvironment|newtheorem|NewDocumentEnvironment)'
                          r'\*?\s*\{([^}]*)\}', text))
    return packages, base.group(1).strip() if base else None, commands, envs


class Checker:
    def __init__(self, main, bibs, engine, snippet):
        self.main = main
        self.root = main.parent
        self.cli_bibs = bibs
        self.engine = engine
        self.snippet = snippet
        self.findings = Findings()
        self.sources = []
        self.visited = set()
        self.missing_inputs = False
        self.envs = []
        self.modes = [Mode('text')]
        self.braces = []
        self.pending_group = None
        self.preamble = not snippet
        self.doc_class = None
        self.doc_class_line = None
        self.class_opts = ''
        self.begin_document = False
        self.end_document = False
        self.packages = []
        self.labels = {}
        self.refs = []
        self.cites = []
        self.bib_names = []
        self.bibitems = set()
        self.defined_cmds = set()
        self.defined_envs = set()
        self.math_macros = False
        self.used = {}
        self.tabular_specs = []
        self.questions = []
        self.uses_marks = False
        self.font_commands = False
        self.external_refs = False
        self.underscore = []
        self.local_class = False

    def error(self, src, line, message):
        self.findings.add('error', src.name, line, message)

    def warn(self, src, line, message):
        self.findings.add('warning', src.name, line, message)

    def mode(self):
        return self.modes[-1]

    def in_math(self):
        return self.mode().kind not in {'text', 'textgroup'}

    def env_names(self):
        return {env.name for env in self.envs}

    def checks_text(self):
        return not self.preamble and not self.env_names() & NO_ESCAPE_ENVS

    def use(self, kind, name, src, line):
        self.used.setdefault((kind, name), (src.name, line))

    def load(self, path):
        resolved = path.resolve()
        if resolved in self.visited:
            return None
        self.visited.add(resolved)
        try:
            name = str(path.relative_to(self.root))
        except ValueError:
            name = path.name
        src = prepare(path, name)
        self.sources.append(src)
        return src

    def run(self):
        src = self.load(self.main)
        self.scan(src)
        self.finish(src)

    def scan(self, src):
        text = src.text
        pos = 0
        while not self.end_document:
            m = TOKEN.search(text, pos)
            if not m:
                return
            pos = m.end()
            kind = m.lastgroup
            line = src.line(m.start())
            if kind == 'cmd':
                pos = self.command(src, m.group('cmd')[1:], m.start(), pos)
            elif kind == 'open':
                self.open_brace(src, line)
            elif kind == 'close':
                self.close_brace(src, line)
            elif kind == 'dollar':
                self.dollar(src, line, m.group('dollar'))
            elif kind == 'par':
                self.paragraph(src, line)
            elif kind == 'char':
                self.special_char(src, line, m.group('char'))
            elif kind == 'fence':
                self.error(src, line, 'Markdown code fence (```) in the .tex file: remove it')
            elif kind == 'dots' and not self.preamble:
                self.warn(src, line, r'write \dots (or \ldots/\cdots in maths) instead of ...')
            elif kind == 'range' and self.checks_text() and not self.in_math():
                self.warn(src, line, 'number range with a hyphen: use an en-dash, e.g. 1--5')
            elif kind == 'bold' and self.checks_text():
                self.warn(src, line, r'Markdown **bold** in LaTeX: use \textbf{...}')

    def open_brace(self, src, line):
        pushed = self.pending_group is not None
        if pushed:
            self.modes.append(Mode(self.pending_group, src.name, line))
            self.pending_group = None
        self.braces.append(Brace(src.name, line, len(self.modes) - (1 if pushed else 0), pushed))

    def close_brace(self, src, line):
        if not self.braces:
            self.error(src, line, 'unmatched } (no { open)')
            return
        if self.envs and len(self.braces) <= self.envs[-1].braces:
            env = self.envs[-1]
            self.error(src, line, f'}} closes a {{ opened before \\begin{{{env.name}}} '
                                  f'({env.file}:{env.line})')
            return
        brace = self.braces.pop()
        keep = brace.modes + (1 if brace.pushed else 0)
        self.close_modes(src, keep, f'the }} on line {line}')
        if brace.pushed:
            self.modes.pop()

    def close_modes(self, src, keep, where):
        while len(self.modes) > max(keep, 1):
            mode = self.modes.pop()
            if mode.kind not in {'textgroup', 'mathgroup', 'env'}:
                self.findings.add('error', mode.file, mode.line,
                                  f'math opened with {mode.kind} is not closed before {where}')

    def dollar(self, src, line, token):
        if self.mode().kind in {'text', 'textgroup'}:
            if token == '$$':
                if not self.preamble:
                    self.warn(src, line, r'$$...$$ is plain TeX: use \[...\] or equation')
            self.modes.append(Mode(token, src.name, line))
            return
        mode = self.mode()
        if mode.kind == token:
            self.close_math(src, line)
            return
        if mode.kind == '$' and token == '$$':
            self.close_math(src, line)
            self.modes.append(Mode('$', src.name, line))
            return
        self.error(src, line, f'{token} inside maths opened at {mode.file}:{mode.line}')

    def close_math(self, src, line):
        mode = self.modes.pop()
        self.check_lr(mode, src, line, 'the end of the formula')

    def check_lr(self, mode, src, line, where):
        if mode.lr > 0:
            self.findings.add('error', mode.file, mode.lr_line,
                              rf'\left without a matching \right before {where} (line {line})')
        elif mode.lr < 0:
            self.findings.add('error', mode.file, mode.lr_line, r'\right without a matching \left')
        mode.lr = 0

    def paragraph(self, src, line):
        mode = self.mode()
        if mode.kind in {'$', '$$', '\\(', '\\['}:
            self.error(src, mode.line, f'math opened with {mode.kind} is not closed before the '
                                       f'blank line {line}')
            self.modes.pop()
        elif mode.kind == 'env':
            self.error(src, line, f'blank line inside {{{mode.env}}}: not allowed in maths')

    def special_char(self, src, line, char):
        if not self.checks_text():
            return
        math = self.in_math()
        if char == '&':
            if not self.env_names() & ALIGN_ENVS:
                where = 'maths' if math else 'text'
                self.error(src, line, rf'unescaped & in {where} outside a table or alignment: '
                                      r'write \&')
        elif char == '#':
            self.error(src, line, r'unescaped # (write \#)')
        elif char == '_' and not math:
            self.underscore.append((src, line))
        elif char == '"' and not math and not self.babel_shorthands():
            self.warn(src, line, "ASCII \" quote: use ``...'' for double quotes")

    def babel_shorthands(self):
        return any(name in {'babel', 'polyglossia'} and re.search(r'german|dutch|spanish', opts)
                   for name, opts, _, _ in self.packages)

    def command(self, src, name, start, pos):
        text = src.text
        line = src.line(start)
        base = name.rstrip('*') or name
        pos = self.skip_overlay(text, pos)
        if name == '\\':
            return self.newline(src, line, text, pos)
        if name in {'(', '['}:
            return self.open_math(src, line, '\\' + name, pos)
        if name in {')', ']'}:
            return self.close_display(src, line, name, pos)
        if base == 'begin':
            return self.begin(src, line, text, pos)
        if base == 'end':
            return self.end(src, line, text, pos)
        if base in {'left', 'right'}:
            return self.left_right(src, line, base, pos)
        if base in FONT_COMMANDS:
            self.font_commands = True
        if base in TEX_DEFS or base == 'let' or base in DEF_GROUPS:
            self.use('cmd', base, src, line)
            return self.definition(src, line, base, text, pos)
        if base in INPUT_CMDS:
            return self.input(src, line, text, pos)
        if base == 'label':
            return self.label(src, line, text, pos)
        if base in REF_CMDS:
            self.use('cmd', base, src, line)
            return self.reference(src, line, base, text, start, pos)
        if re.fullmatch(r'[A-Za-z]*cite[a-zA-Z]*', base) and base not in {'citestyle'}:
            self.use('cmd', base, src, line)
            return self.cite(src, line, base, text, pos)
        if base in {'usepackage', 'RequirePackage'}:
            return self.usepackage(src, line, text, pos)
        if base == 'documentclass':
            return self.documentclass(src, line, text, pos)
        if base in {'bibliography', 'addbibresource'}:
            self.use('cmd', base, src, line)
            value, pos = self.read_arg(text, pos)
            self.bib_names.append((base, value, src, line))
            return pos
        if base == 'bibitem':
            pos = self.skip_optional(text, pos)
            value, pos = self.read_arg(text, pos)
            self.bibitems.add(value.strip())
            return pos
        if base == 'caption':
            self.mark_caption()
        if base in {'verb', 'lstinline', 'mintinline'}:
            self.use('cmd', base, src, line)
            self.need_fragile(src, line)
            return pos
        if base == 'externaldocument':
            self.external_refs = True
        if self.doc_class == 'exam' and base in {'question', 'part', 'subpart', 'subsubpart',
                                                 'titledquestion'}:
            self.exam_marks(src, line, base, text, pos)
        if base in DEPRECATED and not self.preamble:
            self.warn(src, line, f'\\{base} is obsolete: use {DEPRECATED[base]}')
        if base in MATHJAX_ONLY and base not in self.defined_cmds:
            self.error(src, line, f'\\{base} is MathJax-only and undefined in LaTeX')
        if base in TEXT_IN_MATH and self.in_math():
            self.pending_group = 'textgroup' if ARG.match(text, pos) else None
        elif base == 'ensuremath':
            self.pending_group = 'mathgroup' if ARG.match(text, pos) else None
        self.use('cmd', base, src, line)
        if base in RAW_ARG_CMDS or (not self.in_math() and RAW_ARG_PATTERN.match(base)):
            return self.skip_args(text, pos, RAW_ARG_CMDS.get(base, 1), src, line)
        if (not self.in_math() and base not in DELIMITER_PREFIXES
                and (text.startswith('[', pos) or base == 'item')):
            return self.skip_optional(text, pos, src, line, base)
        return pos

    def skip_overlay(self, text, pos):
        if self.doc_class != 'beamer':
            return pos
        m = re.compile(r'<[^<>\n]*>').match(text, pos)
        return m.end() if m else pos

    def read_arg(self, text, pos):
        m = NAME_ARG.match(text, pos)
        if m:
            return m.group(1), m.end()
        m = re.compile(r'\s*(\\[A-Za-z@]+|\S)').match(text, pos)
        return (m.group(1), m.end()) if m else ('', pos)

    def skip_optional(self, text, pos, src=None, line=0, name=''):
        while True:
            spaced = name in {'item', '\\'}
            m = re.compile(r'[ \t]*\n?[ \t]*\[' if spaced else r'\[').match(text, pos)
            if not m:
                return pos
            end = bracket_end(text, m.end() - 1)
            if end is None:
                if src:
                    self.error(src, line, f'[ after \\{name} is never closed by ]')
                return m.end()
            pos = end

    def skip_args(self, text, pos, count, src, line):
        pos = self.skip_optional(text, pos)
        trim = re.compile(r'\([^()\n]*\)').match(text, pos)
        pos = trim.end() if trim else pos
        for _ in range(count):
            m = ARG.match(text, pos)
            if not m:
                return pos
            end = group_end(text, m.end() - 1)
            if end is None:
                self.error(src, line, '{ is never closed by }')
                return len(text)
            pos = self.skip_optional(text, end)
        return pos

    def newline(self, src, line, text, pos):
        mode = self.mode()
        if (mode.kind == 'env' and self.envs and self.envs[-1].name == mode.env
                and mode.env in MULTIROW_MATH_ENVS):
            self.check_lr(mode, src, line, r'the \\ row break')
        pos = self.skip_optional(text, pos, src, line, '\\')
        if (self.checks_text() and not self.in_math() and not self.env_names() & ALIGN_ENVS
                and re.compile(r'[ \t]*\n[ \t]*\n').match(text, pos)):
            self.warn(src, line, r'\\ at the end of a paragraph (underfull box): remove it')
        return pos

    def open_math(self, src, line, token, pos):
        if self.in_math():
            mode = self.mode()
            self.error(src, line, f'{token} inside maths already opened at {mode.file}:{mode.line}')
            return pos
        self.modes.append(Mode(token, src.name, line))
        return pos

    def close_display(self, src, line, name, pos):
        opener = '\\(' if name == ')' else '\\['
        if self.mode().kind == opener:
            self.close_math(src, line)
        else:
            self.error(src, line, f'\\{name} without a matching {opener}')
        return pos

    def left_right(self, src, line, base, pos):
        if not self.in_math():
            return pos
        mode = self.mode()
        if mode.lr == 0:
            mode.lr_line = line
        mode.lr += 1 if base == 'left' else -1
        return pos

    def begin(self, src, line, text, pos):
        m = NAME_ARG.match(text, pos)
        if not m:
            self.error(src, line, r'\begin without an environment name')
            return pos
        name = m.group(1).strip()
        pos = self.skip_overlay(text, m.end())
        opts = ''
        if name not in MATH_ENVS:
            opt = re.compile(r'\s*\[').match(text, pos) if name in FLOAT_ENVS | {'frame'} else (
                re.compile(r'\[').match(text, pos))
            if opt:
                end = bracket_end(text, opt.end() - 1)
                if end is None:
                    self.error(src, line, f'[ after \\begin{{{name}}} is never closed by ]')
                else:
                    opts = text[opt.end():end - 1]
                    pos = end
        self.use('env', name, src, line)
        if name == 'document':
            self.begin_document = True
            self.preamble = False
        elif self.preamble and not self.snippet and name not in {'filecontents', 'filecontents*'}:
            self.error(src, line, f'\\begin{{{name}}} before \\begin{{document}}')
        if name in MATH_ENVS:
            if self.in_math():
                mode = self.mode()
                self.error(src, line, f'\\begin{{{name}}} inside maths opened at '
                                      f'{mode.file}:{mode.line}: use aligned/gathered inside '
                                      r'\[...\], or the environment on its own')
            if name.startswith('eqnarray'):
                self.warn(src, line, 'eqnarray gives bad spacing: use align')
        if name == 'center' and any(env.name in FLOAT_ENVS for env in self.envs):
            self.warn(src, line, r'center environment inside a float: use \centering')
        if name in FRAGILE_ENVS:
            self.need_fragile(src, line)
        if name in {'lstlisting'}:
            for label in re.findall(r'label\s*=\s*\{?([^,\]}]+)', opts):
                self.add_label(src, line, label.strip())
        self.envs.append(Env(name, src.name, line, opts, len(self.braces), len(self.modes)))
        if name in MATH_ENVS:
            self.modes.append(Mode('env', src.name, line, env=name))
        if name in TABULAR_SPEC_ARGS:
            return self.tabular_spec(src, line, name, text, pos)
        return pos

    def tabular_spec(self, src, line, name, text, pos):
        pos = self.skip_optional(text, pos)
        for index in range(TABULAR_SPEC_ARGS[name]):
            m = ARG.match(text, pos)
            if not m:
                return pos
            end = group_end(text, m.end() - 1)
            if end is None:
                self.error(src, line, f'column spec of {name} is never closed by }}')
                return pos
            if index == TABULAR_SPEC_ARGS[name] - 1:
                self.tabular_specs.append((src, line, text[m.end():end - 1]))
            pos = end
        return pos

    def end(self, src, line, text, pos):
        m = NAME_ARG.match(text, pos)
        if not m:
            self.error(src, line, r'\end without an environment name')
            return pos
        name = m.group(1).strip()
        pos = m.end()
        if name == 'document':
            self.end_document = True
        names = [env.name for env in self.envs]
        if name not in names:
            self.error(src, line, f'\\end{{{name}}} without a matching \\begin{{{name}}}')
            return pos
        while self.envs[-1].name != name:
            env = self.envs.pop()
            self.findings.add('error', env.file, env.line,
                              f'\\begin{{{env.name}}} is not closed (\\end{{{name}}} at '
                              f'{src.name}:{line} comes first)')
        env = self.envs.pop()
        for brace in self.braces[env.braces:]:
            self.findings.add('error', brace.file, brace.line,
                              f'{{ is not closed before \\end{{{name}}} (line {line})')
        del self.braces[env.braces:]
        if name in MATH_ENVS:
            while len(self.modes) > env.modes + 1:
                mode = self.modes.pop()
                if mode.kind not in {'textgroup', 'mathgroup'}:
                    self.findings.add('error', mode.file, mode.line,
                                      f'math opened with {mode.kind} is not closed before '
                                      f'\\end{{{name}}}')
            if len(self.modes) > env.modes:
                self.check_lr(self.modes.pop(), src, line, f'\\end{{{name}}}')
        else:
            self.close_modes(src, env.modes, f'\\end{{{name}}} on line {line}')
        return pos

    def definition(self, src, line, base, text, pos):
        if base == 'let':
            m = re.compile(r'\s*\\([A-Za-z@]+)\s*=?\s*(\\[A-Za-z@]+|.)').match(text, pos)
            if m:
                self.defined_cmds.add(m.group(1))
                return m.end()
            return pos
        if base in TEX_DEFS:
            m = re.compile(r'\s*\\([A-Za-z@]+|.)[^{]*').match(text, pos)
            if not m:
                return pos
            self.defined_cmds.add(m.group(1))
            end = group_end(text, m.end())
            if end is None:
                self.error(src, line, f'\\{base} body is never closed by }}')
                return len(text)
            self.definition_body(src, line, text[m.end():end])
            return end
        pos = re.compile(r'\*?').match(text, pos).end()
        for index in range(DEF_GROUPS[base]):
            pos = self.skip_optional(text, re.compile(r'\s*').match(text, pos).end())
            m = re.compile(r'\s*(\{|\\[A-Za-z@]+)').match(text, pos)
            if not m:
                return pos
            if m.group(1) != '{':
                if index == 0:
                    self.defined_cmds.add(m.group(1)[1:])
                pos = m.end()
                continue
            end = group_end(text, m.end() - 1)
            if end is None:
                self.error(src, line, f'\\{base} argument is never closed by }}')
                return len(text)
            body = text[m.end():end - 1]
            if index == 0:
                self.record_definition(base, body.strip())
            else:
                self.definition_body(src, line, body)
            pos = end
        return self.skip_optional(text, pos)

    def record_definition(self, base, name):
        if base in ENV_DEFINERS:
            self.defined_envs.add(name)
        else:
            self.defined_cmds.add(name.lstrip('\\'))

    def definition_body(self, src, line, body):
        for cmd in re.findall(r'\\([A-Za-z]+)', body):
            self.use('cmd', cmd, src, line)
        for env in re.findall(r'\\begin\s*\{([^{}]*)\}', body):
            self.use('env', env.strip(), src, line)
        if re.search(r'\\begin\s*\{(?:' + '|'.join(re.escape(e) for e in MATH_ENVS)
                     + r')\}|\\\[|\\\(|\$', body):
            self.math_macros = True

    def input(self, src, line, text, pos):
        m = NAME_ARG.match(text, pos) or re.compile(r'[ \t]+([^\s{}\\]+)').match(text, pos)
        if not m:
            return pos
        target = m.group(1).strip()
        base_dir = src.path.parent if src.path != self.main else self.root
        candidates = [self.root / target, self.root / f'{target}.tex', base_dir / target,
                      base_dir / f'{target}.tex']
        found = next((path for path in candidates if path.is_file()), None)
        if found is None:
            self.missing_inputs = True
            self.warn(src, line, f'\\input/\\include file "{target}" not found: not checked')
            return m.end()
        child = self.load(found)
        if child is not None:
            self.scan(child)
        return m.end()

    def label(self, src, line, text, pos):
        value, pos = self.read_arg(text, pos)
        key = value.replace(BLANK, '').strip()
        if not key:
            self.warn(src, line, r'empty \label{}')
            return pos
        self.add_label(src, line, key)
        float_env = self.label_float()
        if float_env is not None and not float_env.caption_seen:
            self.warn(src, line, rf'\label{{{key}}} before \caption in {float_env.name}: put it '
                                 r'after the \caption so it gets the right number')
        return pos

    def label_float(self):
        for env in reversed(self.envs):
            if env.name in LABEL_OWNER_ENVS or env.name in self.defined_envs:
                return None
            if env.name in FLOAT_ENVS:
                return env
        return None

    def mark_caption(self):
        for env in reversed(self.envs):
            if env.name in FLOAT_ENVS:
                env.caption_seen = True
                return

    def add_label(self, src, line, key):
        self.labels.setdefault(key, []).append((src.name, line))

    def reference(self, src, line, base, text, start, pos):
        pos = self.skip_optional(text, pos)
        value, pos = self.read_arg(text, pos)
        for key in split_keys(value):
            self.refs.append((base, key, src, line))
        before = text[max(0, start - 2):start]
        if (base in TILDE_REF_CMDS and self.checks_text() and not self.in_math()
                and len(before) == 2 and before[1] in ' \n' and before[0].isalnum()):
            self.warn(src, line, rf'use a non-breaking space before \{base}: Figure~\ref{{...}}')
        return pos

    def cite(self, src, line, base, text, pos):
        multi = base.endswith('cites')
        while True:
            pos = self.skip_optional(text, pos)
            m = ARG.match(text, pos)
            if not m:
                return pos
            end = group_end(text, m.end() - 1)
            if end is None:
                self.error(src, line, f'\\{base}{{ is never closed by }}')
                return len(text)
            for key in split_keys(text[m.end():end - 1]):
                self.cites.append((key, src, line))
            pos = end
            if not multi:
                return pos

    def usepackage(self, src, line, text, pos):
        opt = re.compile(r'\s*\[').match(text, pos)
        opts = ''
        if opt:
            end = bracket_end(text, opt.end() - 1)
            if end is None:
                self.error(src, line, r'[ after \usepackage is never closed by ]')
                return opt.end()
            opts = text[opt.end():end - 1]
            pos = end
        value, pos = self.read_arg(text, pos)
        if not self.preamble and not self.snippet:
            self.error(src, line, r'\usepackage after \begin{document}: move it to the preamble')
        for name in split_keys(value):
            self.packages.append((name, opts, src, line))
            local = self.root / f'{name}.sty'
            if local.is_file():
                self.read_local_definitions(local, opts)
        return self.skip_optional(text, pos)

    def documentclass(self, src, line, text, pos):
        opt = re.compile(r'\s*\[').match(text, pos)
        if opt:
            end = bracket_end(text, opt.end() - 1)
            self.class_opts = text[opt.end():end - 1] if end else ''
            pos = end or opt.end()
        value, pos = self.read_arg(text, pos)
        self.doc_class = value.strip()
        self.doc_class_line = (src.name, line)
        local = self.root / f'{self.doc_class}.cls'
        if local.is_file():
            self.local_class = True
            self.read_local_definitions(local, '')
        return pos

    def read_local_definitions(self, path, opts):
        seen = set()
        while path is not None and path not in seen:
            seen.add(path)
            packages, base, commands, envs = scan_definitions(path)
            for name in packages:
                self.packages.append((name, opts, None, 0))
            self.defined_cmds |= commands
            self.defined_envs |= envs
            if base is None:
                return
            if base in CLASS_PACKAGES:
                self.packages.extend((name, '', None, 0) for name in CLASS_PACKAGES[base])
                return
            nxt = self.root / f'{base}.cls'
            path = nxt if nxt.is_file() else None

    def need_fragile(self, src, line):
        for env in reversed(self.envs):
            if env.name != 'frame':
                continue
            if 'fragile' not in env.opts and not env.fragile_reported:
                env.fragile_reported = True
                self.findings.add('error', env.file, env.line,
                                  r'frame with verbatim/listings code needs \begin{frame}[fragile] '
                                  f'(code on line {line})')
            return

    def exam_marks(self, src, line, base, text, pos):
        title = ARG.match(text, pos) if base == 'titledquestion' else None
        if title:
            pos = group_end(text, title.end() - 1) or pos
        marks = bool(re.compile(r'\s*\[').match(text, pos))
        self.uses_marks = self.uses_marks or marks
        if base in {'question', 'titledquestion'}:
            self.questions.append(Question(src.name, line, marks))
        elif marks and self.questions:
            self.questions[-1].part_marks = True

    def finish(self, src):
        self.finish_structure(src)
        for env in self.envs:
            if env.name == 'document':
                continue
            self.findings.add('error', env.file, env.line, f'\\begin{{{env.name}}} is never closed')
        for brace in self.braces[:5]:
            self.findings.add('error', brace.file, brace.line, '{ is never closed by }')
        for mode in self.modes[1:]:
            if mode.kind not in {'textgroup', 'mathgroup'}:
                self.findings.add('error', mode.file, mode.line,
                                  f'math opened with {mode.kind or mode.env} is never closed')
        self.finish_escapes()
        self.finish_labels()
        self.finish_cites(src)
        if not self.snippet:
            self.finish_packages()
        self.finish_scripts()
        self.finish_tables()
        self.finish_exam()

    def finish_structure(self, src):
        if self.snippet:
            return
        if self.doc_class is None:
            self.error(src, 1, r'no \documentclass: a complete document starts with one')
        if not self.begin_document:
            self.error(src, 1, r'no \begin{document}')
        elif not self.end_document:
            self.error(src, src.line(len(src.text)), r'no \end{document}')

    def finish_escapes(self):
        if not self.math_macros:
            for src, line in self.underscore:
                self.error(src, line, r'unescaped _ in text: write \_ or put it in maths $x_1$')
        for src in self.sources:
            for line in src.percent_lines:
                self.error(src, line, r'number followed by % starts a comment: write 50\%')

    def finish_labels(self):
        for key, places in self.labels.items():
            for file, line in places[1:]:
                self.findings.add('error', file, line,
                                  f'duplicate \\label{{{key}}} (first at {places[0][0]}:'
                                  f'{places[0][1]})')
        if self.external_refs:
            return
        lenient = self.snippet or self.missing_inputs
        for base, key, src, line in self.refs:
            if key in self.labels:
                continue
            message = f'\\{base}{{{key}}} has no matching \\label'
            if lenient:
                self.warn(src, line, message + ' in the files checked')
            else:
                self.error(src, line, message)

    def bib_paths(self):
        paths, missing = list(self.cli_bibs), []
        for _, value, _, _ in self.bib_names:
            for name in split_keys(value):
                options = [self.root / name, self.root / f'{name}.bib']
                found = next((p for p in options if p.is_file() and p.suffix == '.bib'), None)
                if found is None:
                    found = next((p for p in options if p.is_file()), None)
                if found:
                    paths.append(found)
                else:
                    missing.append(name)
        return paths, missing

    def finish_cites(self, src):
        keys = [key for key, _, _ in self.cites if key != '*']
        if not keys:
            return
        paths, missing = self.bib_paths()
        for name in missing:
            file, line = next(((s.name, line) for b, v, s, line in self.bib_names if name in v),
                              (src.name, 1))
            self.findings.add('warning', file, line,
                              f'bibliography file "{name}" not found: citation keys not checked')
        if not paths and not self.bibitems:
            if not missing and not self.snippet:
                key, csrc, line = self.cites[0]
                self.error(csrc, line, r'citations but no bibliography: add \bibliography{...} '
                                       r'(or \addbibresource) and a .bib file')
            return
        known = set(self.bibitems)
        for path in paths:
            entries = parse_bib(path)
            known |= set(entries)
            for key, lines in entries.items():
                if len(lines) > 1:
                    self.findings.add('warning', path.name, lines[1],
                                      f'duplicate bib key {key} (first on line {lines[0]})')
        if missing and not known:
            return
        lowered = {key.lower(): key for key in known}
        for key, csrc, line in self.cites:
            if key == '*' or key in known:
                continue
            hint = f' (the .bib has {lowered[key.lower()]})' if key.lower() in lowered else ''
            self.error(csrc, line, f'\\cite key "{key}" is not in the bibliography{hint}')

    def loaded_packages(self):
        names = {name for name, _, _, _ in self.packages}
        names |= CLASS_PACKAGES.get(self.doc_class, set())
        if any(name == 'xcolor' and 'table' in opts for name, opts, _, _ in self.packages):
            names.add('colortbl')
        return package_closure(names)

    def finish_packages(self):
        loaded = self.loaded_packages()
        trusted = self.doc_class in CLASS_PACKAGES or self.local_class
        for (kind, name), (file, line) in sorted(self.used.items(), key=lambda i: i[1][1]):
            table = CMD_PACKAGES if kind == 'cmd' else ENV_PACKAGES
            providers = table.get(name)
            if not providers or (name in self.defined_cmds if kind == 'cmd'
                                 else name in self.defined_envs):
                continue
            if name in {'mathbb', 'mathfrak'} and loaded & MATH_FONT_PACKAGES:
                continue
            if loaded & set(providers):
                continue
            shown = f'\\{name}' if kind == 'cmd' else f'\\begin{{{name}}}'
            alt = f' (or {", ".join(providers[1:])})' if len(providers) > 1 else ''
            message = f'{shown} needs \\usepackage{{{providers[0]}}}{alt}'
            if trusted:
                self.findings.add('error', file, line, message)
            else:
                self.findings.add('warning', file, line,
                                  f'{message}, unless class {self.doc_class} loads it')
        self.finish_theorems(loaded, trusted)
        self.finish_package_order()

    def finish_theorems(self, loaded, trusted):
        if not trusted or self.local_class or 'ntheorem' in loaded:
            return
        provided = CLASS_THEOREMS.get(self.doc_class, set())
        for (kind, name), (file, line) in self.used.items():
            if (kind == 'env' and name in THEOREM_NAMES and name not in self.defined_envs
                    and name not in provided):
                self.findings.add('error', file, line,
                                  f'environment {name} is not defined: add \\newtheorem{{{name}}}'
                                  f'{{{name.title()}}} to the preamble')

    def finish_package_order(self):
        order = [(name, src, line) for name, _, src, line in self.packages if src is not None]
        names = [name for name, _, _ in order]
        if 'hyperref' not in names:
            return
        index = names.index('hyperref')
        late = [name for name in names[index + 1:] if name not in AFTER_HYPERREF_OK]
        _, src, line = order[index]
        if late:
            self.warn(src, line, f'load hyperref after the other packages (found after it: '
                                 f'{", ".join(late[:4])}); only cleveref/bookmark go after it')
        if 'cleveref' in names and names.index('cleveref') < index:
            _, csrc, cline = order[names.index('cleveref')]
            self.warn(csrc, cline, 'load cleveref after hyperref')

    def finish_scripts(self):
        loaded = self.loaded_packages()
        fontspec = 'fontspec' in loaded
        found, unsafe = {}, {}
        for src in self.sources:
            for index, char in enumerate(src.text):
                code = ord(char)
                if code < 0x370:
                    continue
                for script, low, high, font in SCRIPTS:
                    if low <= code <= high:
                        found.setdefault(script, (src, src.line(index), font))
                if any(low <= code <= high for low, high in PDFTEX_UNSAFE):
                    unsafe.setdefault(char, (src, src.line(index)))
        spec = next(((name, src, line) for name, _, src, line in self.packages
                     if name in UNICODE_PACKAGES and src is not None), None)
        if spec and self.engine == 'pdflatex':
            self.error(spec[1], spec[2], f'{spec[0]} needs XeLaTeX or LuaLaTeX, not pdfLaTeX')
        unicode_engine = (self.engine in {'xelatex', 'lualatex'}
                          or (self.engine is None and fontspec))
        for script, (src, line, font) in found.items():
            if self.engine == 'pdflatex' or (self.engine is None and not fontspec
                                              and not self.snippet):
                self.error(src, line, f'{script} text cannot be typeset by pdfLaTeX: use XeLaTeX '
                                      rf'with \usepackage{{fontspec}} and a font such as '
                                      f'\\newfontfamily or \\setmainfont{{{font}}}')
            elif not fontspec and not self.snippet:
                self.error(src, line, rf'{script} text needs \usepackage{{fontspec}} and a font '
                                      f'with {script} glyphs, e.g. {font}')
            elif not self.font_commands and not self.snippet:
                self.warn(src, line, f'{script} text but no font is set: add '
                                     f'\\setmainfont{{{font}}} or \\newfontfamily')
        greek_ok = loaded & GREEK_PACKAGES or self.babel_greek()
        if unicode_engine or (self.snippet and self.engine is None):
            return
        for char, (src, line) in list(unsafe.items())[:6]:
            if greek_ok and 0x370 <= ord(char) <= 0x3FF:
                continue
            self.error(src, line, f'Unicode character {char} (U+{ord(char):04X}) is not set up '
                                  'for pdfLaTeX: write the LaTeX command (e.g. \\alpha, \\leq) '
                                  'in maths')

    def babel_greek(self):
        return any(name == 'babel' and 'greek' in opts for name, opts, _, _ in self.packages)

    def finish_tables(self):
        if 'booktabs' not in self.loaded_packages():
            return
        for src, line, spec in self.tabular_specs:
            if '|' in spec:
                self.warn(src, line, 'vertical rules (|) in the column spec of a booktabs table: '
                                     'remove them')

    def finish_exam(self):
        if not self.uses_marks:
            return
        for question in self.questions:
            if not question.marks and not question.part_marks:
                self.findings.add('warning', question.file, question.line,
                                  r'\question without marks while other questions have them: '
                                  r'\question[5] or marks on its \part[...]s')

    def todo_markers(self):
        markers = []
        for src in self.sources:
            markers += [(src.name, n) for n, text in src.comments
                        if re.search(r'\bTODO\b|\bFIXME\b', text)]
            markers += [(src.name, src.line(m.start())) for m in
                        re.finditer(r'\\todo\b|\[citation needed|PLACEHOLDER', src.text)]
        return markers

    def engine_label(self):
        if self.engine:
            return ENGINE_NAMES[self.engine]
        return 'XeLaTeX' if 'fontspec' in self.loaded_packages() else 'pdfLaTeX'


def report(checker, strict):
    findings = checker.findings
    errors, warnings = findings.count('error'), findings.count('warning')
    extra = len(checker.sources) - 1
    plural = 's' if extra > 1 else ''
    files = checker.sources[0].name + (f' (+{extra} included file{plural})' if extra else '')
    kind = f'class {checker.doc_class}' if checker.doc_class else 'fragment'
    lines = [f'LaTeX check: {files}, {kind}, engine {checker.engine_label()} '
             '(static check, not compiled)']
    lines.append(f'errors ({errors}):')
    lines += findings.lines('error')
    lines.append(f'warnings ({warnings}):')
    lines += findings.lines('warning')
    markers = checker.todo_markers()
    if markers:
        where = ', '.join(f'{name}:{line}' for name, line in markers[:8])
        lines.append(f'info: {len(markers)} TODO/placeholder marker(s) at {where}; '
                     'tell the user about each one')
    failed = errors or (strict and warnings)
    if errors:
        lines.append(f'result: {errors} error(s). Fix them all in one edit, then run the check '
                     'again.')
    elif failed:
        lines.append(f'result: {warnings} warning(s) with --strict. Fix them, then run again.')
    else:
        lines.append('result: no errors. Say the file was checked but not compiled.')
    return '\n'.join(lines), 2 if failed else 0


def check(path, bibs=(), engine=None, snippet=False, strict=False):
    checker = Checker(Path(path), [Path(b) for b in bibs], engine, snippet)
    checker.run()
    return report(checker, strict)


def main(argv=None):
    parser = Parser(description='Static check of a LaTeX document (does not compile).')
    parser.add_argument('path', type=Path, help='the main .tex file')
    parser.add_argument('--bib', action='append', default=[], type=Path,
                        help='a .bib file to check \\cite keys against (repeatable)')
    parser.add_argument('--engine', choices=['pdflatex', 'xelatex', 'lualatex'],
                        help='the engine the user will compile with')
    parser.add_argument('--snippet', action='store_true',
                        help='a fragment: no \\documentclass needed, package checks skipped')
    parser.add_argument('--strict', action='store_true', help='warnings also fail the check')
    args = parser.parse_args(argv)
    for path in [args.path, *args.bib]:
        if not path.is_file():
            print(f'error: no file at {path}', file=sys.stderr)
            return 1
    text, code = check(args.path, args.bib, args.engine, args.snippet, args.strict)
    print(text)
    return code


if __name__ == '__main__':
    sys.exit(main())
