"""Turn pandoc's Word-to-LaTeX output into a clean, standard LaTeX document, then check it.

Usage: python clean_pandoc.py IN.tex OUT.tex [--class article|report] [--engine ENGINE]

Run pandoc first:  pandoc input.docx -s -o qa/raw.tex --extract-media=qa/
Keeps the body and title, rebuilds a minimal preamble with only the packages the body uses
(hyperref last), and cleans pandoc's noise: \\tightlist, \\def\\labelenumi lines, \\hypertarget
wrappers, \\pandocbounded, longtables of 30 rows or fewer (become table + tabular with booktabs),
minipage-wrapped header cells, \\(...\\) (becomes $...$), $$...$$ (becomes \\[...\\]), {[} and {]},
and manual "1.2" numbers in headings. Then runs check_tex.py on OUT.tex and prints its report.

Exit codes: 0 clean, 2 defects listed in the report, 1 bad arguments.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_tex import CMD_PACKAGES, ENV_PACKAGES, SCRIPTS, Parser, check, group_end  # noqa: E402

SHORT_TABLE_ROWS = 30
DEFAULT_LABELS = {
    'i': r'\arabic{enumi}.', 'ii': r'(\alph{enumii})', 'iii': r'\roman{enumiii}.',
    'iv': r'\Alph{enumiv}.',
}
BABEL_NAMES = {'Sinhala': 'sinhala', 'Tamil': 'tamil', 'Bengali': 'bengali',
               'Devanagari': 'hindi', 'Malayalam': 'malayalam', 'Telugu': 'telugu'}
PACKAGE_ORDER = [
    'amsmath', 'amssymb', 'graphicx', 'adjustbox', 'array', 'booktabs', 'longtable', 'multirow',
    'xcolor', 'soul', 'ulem', 'enumitem', 'listings', 'fancyvrb', 'caption', 'subcaption',
    'siunitx',
]
LAST_PACKAGES = {'hyperref', 'url', 'cleveref'}
HEADING = re.compile(r'\\(chapter|section|subsection|subsubsection)(\*?)\{')
MANUAL_NUMBER = re.compile(r'^\s*(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+')
COLUMN = re.compile(
    r'>\{\\(raggedright|centering|raggedleft)\\arraybackslash\}'
    r'p\{\(\\(?:columnwidth|linewidth) - \d+\\tabcolsep\) \* \\real\{([\d.]+)\}\}')
HIGHLIGHT_LINE = re.compile(r'\\newcommand\{\\[A-Za-z]+Tok\}|\\DefineVerbatimEnvironment|'
                            r'\\newenvironment\{Shaded\}|\\usepackage\{fancyvrb\}|'
                            r'\\usepackage\{color\}|\\definecolor\{shadecolor\}')


def braced(text, start):
    """Return (content, end) of the brace group opening at text[start] == '{'."""
    end = group_end(text, start)
    if end is None:
        return None, start
    return text[start + 1:end - 1], end


def split_document(text):
    begin = text.find('\\begin{document}')
    if begin < 0:
        return '', text
    end = text.rfind('\\end{document}')
    body = text[begin + len('\\begin{document}'):end if end > begin else len(text)]
    return text[:begin], body


def title_block(preamble):
    lines = []
    for name in ('title', 'subtitle', 'author', 'date'):
        m = re.search(r'\\' + name + r'\{', preamble)
        if not m:
            continue
        content, _ = braced(preamble, m.end() - 1)
        if content and content.strip():
            lines.append(f'\\{name}{{{content.strip()}}}')
    return lines


def highlighting(preamble):
    return [line for line in preamble.splitlines() if HIGHLIGHT_LINE.search(line)]


def unwrap_hypertargets(body):
    removed = set()
    count = 0
    pattern = re.compile(r'(?:\\protect)?\\hypertarget\{')
    while True:
        m = pattern.search(body)
        if not m:
            break
        target, after = braced(body, m.end() - 1)
        if target is None or not body.startswith('{', after):
            break
        content, end = braced(body, after)
        if content is None:
            break
        removed.add(target)
        content = re.sub(r'^%?\n', '', content)
        if not content and body.startswith('{}', end):
            end += 2
        body = body[:m.start()] + content + body[end:]
        count += 1
    for target in removed:
        escaped = re.escape(target)
        body = re.sub(r'\\hyperref\[' + escaped + r'\]\{([^{}]*)\}', r'\1', body)
        body = re.sub(r'\\hyperlink\{' + escaped + r'\}\{([^{}]*)\}', r'\1', body)
    return body, count


def unwrap_command(body, name):
    count = 0
    pattern = re.compile(r'\\' + name + r'\{')
    while True:
        m = pattern.search(body)
        if not m:
            return body, count
        content, end = braced(body, m.end() - 1)
        if content is None:
            return body, count
        body = body[:m.start()] + content + body[end:]
        count += 1


def size_images(body):
    def fix(m):
        opts = m.group(1) or ''
        if re.search(r'\b(width|height|scale)\s*=', opts):
            return m.group(0)
        return r'\includegraphics[max width=\linewidth]{'
    return re.subn(r'\\includegraphics(?:\[([^\]]*)\])?\{', fix, body)


def enumerate_label(line):
    m = re.match(r'\s*\\def\\labelenum(i{1,3}|iv)\{(.*)\}\s*$', line)
    if not m:
        return None
    level, label = m.groups()
    if label == DEFAULT_LABELS[level]:
        return ''
    return re.sub(r'\\(arabic|alph|Alph|roman|Roman)\{enum[iv]+\}', r'\\\1*', label)


def clean_lists(body):
    out, stats = [], {'tightlist': 0, 'labels': 0}
    last_enumerate = None
    for line in body.split('\n'):
        if line.strip() == '\\tightlist':
            stats['tightlist'] += 1
            continue
        label = enumerate_label(line)
        if label is not None:
            stats['labels'] += 1
            if label and last_enumerate is not None:
                out[last_enumerate] = out[last_enumerate].rstrip() + f'[label={{{label}}}]'
            continue
        if re.match(r'\s*\\begin\{enumerate\}\s*$', line):
            last_enumerate = len(out)
        out.append(line)
    body = '\n'.join(out)
    body = re.sub(r'(?m)^([ \t]*)\\item[ \t]*\n[ \t]+(?=\S)', r'\1\\item ', body)
    return body, stats


def column_spec(spec):
    spec = spec.replace('@{}', '').strip()
    columns = []
    pos = 0
    while pos < len(spec):
        m = COLUMN.match(spec, pos)
        if m:
            columns.append((m.group(1), float(m.group(2))))
            pos = m.end()
            continue
        char = spec[pos]
        if char in 'lcr':
            columns.append((char, None))
        elif not char.isspace():
            columns.append((char, None))
        pos += 1
    factor = 0.97 - 0.025 * len(columns)
    parts = [f'>{{\\{kind}\\arraybackslash}}p{{{max(0.05, real * factor):.2f}\\linewidth}}'
             if real is not None else kind for kind, real in columns]
    return '@{}' + ''.join(parts) + '@{}', len(columns)


def cut(text, marker):
    index = text.find(marker)
    if index < 0:
        return None, text
    return text[:index], text[index + len(marker):]


def strip_rules(text):
    text = re.sub(r'\\(toprule|midrule|bottomrule)\b(\\noalign\{\})?', '', text)
    return '\n'.join(line.rstrip() for line in text.split('\n') if line.strip())


def table_parts(content):
    content = content.replace('\\noalign{}', '').replace('\\tabularnewline', '\\\\')
    content = re.sub(r'\\begin\{minipage\}\[b\]\{\\linewidth\}'
                     r'\\(?:raggedright|centering|raggedleft)\s*(.*?)\s*\\end\{minipage\}',
                     lambda m: ' '.join(m.group(1).split()), content, flags=re.S)
    caption = ''
    m = re.search(r'\\caption\{', content)
    if m:
        text, end = braced(content, m.end() - 1)
        label = re.compile(r'\s*(\\label\{[^{}]*\})').match(content, end)
        label_text = label.group(1) if label else ''
        end = label.end() if label else end
        tail = re.compile(r'\s*\\\\').match(content, end)
        end = tail.end() if tail else end
        caption = f'\\caption{{{text}}}' + (f'\n  {label_text}' if label_text else '')
        content = content[:m.start()] + content[end:]
    head, rest = cut(content, '\\endfirsthead')
    if head is not None:
        _, rest = cut(rest, '\\endhead')
    else:
        head, rest = cut(content, '\\endhead')
    for marker in ('\\endlastfoot', '\\endfoot'):
        foot, after = cut(rest, marker)
        if foot is not None:
            rest = after
    rows = strip_rules(re.sub(r'\\bottomrule\b', '', rest))
    return caption, strip_rules(head or ''), rows


def indent(text, spaces):
    pad = ' ' * spaces
    return '\n'.join(pad + line.strip() if line.strip() else '' for line in text.split('\n'))


def wrap_spec(spec):
    if len(spec) <= 60:
        return spec
    columns = re.findall(r'>\{[^{}]*\}p\{[^{}]*\}|[^@{}]|@\{\}', spec)
    return '\n'.join(['@{}'] + [f'      {column}' for column in columns if column != '@{}']) + '@{}'


def build_table(spec, caption, head, rows):
    count = rows.count('\\\\')
    head_lines = ['\\toprule'] + ([head, '\\midrule'] if head else [])
    if count > SHORT_TABLE_ROWS:
        lines = [f'\\begin{{longtable}}{{{spec}}}']
        if caption:
            lines.append(indent(caption, 2) + ' \\\\')
        lines += [indent(line, 2) for line in head_lines] + ['  \\endhead']
        lines += [indent(rows, 2), '  \\bottomrule', '\\end{longtable}']
        return '\n'.join(lines), False
    outer = 'table' if caption else 'center'
    lines = [f'\\begin{{{outer}}}' + ('[htbp]' if caption else '')]
    if caption:
        lines += ['  \\centering', indent(caption, 2)]
    lines.append(f'  \\begin{{tabular}}{{{wrap_spec(spec)}}}')
    lines += [indent(line, 4) for line in head_lines]
    lines += [indent(rows, 4), '    \\bottomrule', '  \\end{tabular}', f'\\end{{{outer}}}']
    return '\n'.join(lines), True


def convert_tables(body):
    stats = {'short': 0, 'long': 0}
    pattern = re.compile(r'\\begin\{longtable\}(?:\[[^\]]*\])?\{')
    pos = 0
    while True:
        m = pattern.search(body, pos)
        if not m:
            return body, stats
        spec, spec_end = braced(body, m.end() - 1)
        close = body.find('\\end{longtable}', spec_end)
        if spec is None or close < 0:
            return body, stats
        new_spec, _ = column_spec(spec)
        caption, head, rows = table_parts(body[spec_end:close])
        table, short = build_table(new_spec, caption, head, rows)
        stats['short' if short else 'long'] += 1
        body = body[:m.start()] + table + body[close + len('\\end{longtable}'):]
        pos = m.start() + len(table)


def convert_math(body):
    body, inline = re.subn(r'(?<!\\)\\\((.+?)\\\)', lambda m: f'${m.group(1).strip()}$', body,
                           flags=re.S)
    body, display = re.subn(r'\$\$(.+?)\$\$', lambda m: f'\\[{m.group(1)}\\]', body, flags=re.S)
    return body, inline + display


def convert_brackets(body):
    def fix(m):
        before = body[:m.start()].rstrip()
        if re.search(r'(\\[A-Za-z]+\*?|\\\\|[\]}])$', before):
            return m.group(0)
        return f'[{m.group(1)}]'
    return re.subn(r'\{\[\}([^\n]*?)\{\]\}', fix, body)


def strip_heading_numbers(body):
    headings = [(m, braced(body, m.end() - 1)) for m in HEADING.finditer(body)]
    numbered = [h for h in headings if h[1][0] and MANUAL_NUMBER.match(h[1][0])]
    if len(numbered) < 2 or len(numbered) * 10 < len(headings) * 6:
        return body, 0
    for m, (title, end) in reversed(numbered):
        body = body[:m.end()] + MANUAL_NUMBER.sub('', title, count=1) + body[end - 1:]
    return body, len(numbered)


def figure_placement(body):
    return re.subn(r'\\begin\{figure\}(?!\[)', r'\\begin{figure}[htbp]', body)


def tidy(body):
    body = re.sub(r'[ \t]+\n', '\n', body)
    body = re.sub(r'\n{3,}', '\n\n', body)
    return body.strip('\n')


def scripts_in(text):
    found = []
    for name, low, high, font in SCRIPTS:
        if any(low <= ord(char) <= high for char in text):
            found.append((name, font))
    return found


def needed_packages(body):
    needed = set()
    for name in set(re.findall(r'\\([A-Za-z]+)', body)):
        needed.add(CMD_PACKAGES.get(name, (None,))[0])
    for name in set(re.findall(r'\\begin\{([^{}]+)\}', body)):
        needed.add(ENV_PACKAGES.get(name, (None,))[0])
    if re.search(r'(?<!\\)\$|\\\[|\\begin\{(equation|align)', body):
        needed |= {'amsmath', 'amssymb'}
    if 'max width=' in body:
        needed.add('adjustbox')
    if '\\arraybackslash' in body:
        needed.add('array')
    if re.search(r'\\begin\{enumerate\}\[label=', body):
        needed.add('enumitem')
    if '\\begin{Shaded}' in body:
        needed.discard('fancyvrb')
    needed.discard(None)
    return needed


def package_lines(needed):
    ordered = [name for name in PACKAGE_ORDER if name in needed]
    ordered += sorted(needed - set(PACKAGE_ORDER) - LAST_PACKAGES)
    lines = []
    for name in ordered:
        if name == 'amssymb' and 'amsmath' in ordered:
            continue
        if name == 'amsmath' and 'amssymb' in needed:
            lines.append('\\usepackage{amsmath,amssymb}')
        elif name == 'adjustbox':
            lines.append('\\usepackage[export]{adjustbox}')
        else:
            lines.append(f'\\usepackage{{{name}}}')
    lines.append('\\usepackage[hidelinks]{hyperref}')
    return lines


def font_lines(scripts):
    if not scripts:
        return ['\\usepackage[T1]{fontenc}', '\\usepackage{lmodern}']
    lines = ['\\usepackage{fontspec}', '\\usepackage[english]{babel}']
    for name, font in scripts:
        language = BABEL_NAMES.get(name)
        if language:
            lines.append(f'\\babelprovide[import, onchar=ids fonts]{{{language}}}')
            lines.append(f'\\babelfont[{language}]{{rm}}{{{font}}}')
    return lines


def assemble(preamble, body, doc_class):
    scripts = scripts_in(body)
    lines = [f'\\documentclass[11pt,a4paper]{{{doc_class}}}', '']
    lines += font_lines(scripts)
    lines.append('\\usepackage[margin=25mm]{geometry}')
    lines += package_lines(needed_packages(body))
    if '\\begin{Shaded}' in body:
        lines += [''] + highlighting(preamble)
    titles = title_block(preamble)
    if titles:
        lines += [''] + titles
    lines += ['', '\\begin{document}', '']
    if any(t.startswith('\\title') for t in titles) and '\\maketitle' not in body:
        lines += ['\\maketitle', '']
    lines += [body, '', '\\end{document}', '']
    return '\n'.join(lines), scripts


def clean(text, doc_class=None):
    preamble, body = split_document(text)
    body, hypertargets = unwrap_hypertargets(body)
    body, bounded = unwrap_command(body, 'pandocbounded')
    body, images = size_images(body)
    body, lists = clean_lists(body)
    body, tables = convert_tables(body)
    body, maths = convert_math(body)
    body, brackets = convert_brackets(body)
    body, numbers = strip_heading_numbers(body)
    body, figures = figure_placement(body)
    body = tidy(body)
    doc_class = doc_class or ('report' if '\\chapter{' in body else 'article')
    output, scripts = assemble(preamble, body, doc_class)
    notes = [
        f'removed {lists["tightlist"]} \\tightlist and {lists["labels"]} \\def\\labelenum lines',
        f'unwrapped {hypertargets} \\hypertarget and {bounded} \\pandocbounded',
        f'tables: {tables["short"]} longtable(s) became table+tabular, {tables["long"]} kept as '
        'longtable (over 30 rows)',
        f'{maths} maths delimiters normalised ($...$ inline, \\[...\\] display); '
        f'{brackets} {{[}}...{{]}} fixed',
        f'{images} images sized to the line width; {figures} figures given [htbp]',
    ]
    if numbers:
        notes.append(f'removed manual numbers from {numbers} headings (LaTeX numbers them)')
    return output, notes, scripts


def main(argv=None):
    parser = Parser(description="Clean pandoc's Word-to-LaTeX output and check it.")
    parser.add_argument('input', type=Path, help="pandoc's .tex output")
    parser.add_argument('output', type=Path, help='the cleaned .tex to write')
    parser.add_argument('--class', dest='doc_class', choices=['article', 'report', 'book'],
                        help='document class (default: report when there are chapters)')
    parser.add_argument('--engine', choices=['pdflatex', 'xelatex', 'lualatex'],
                        help='engine for the check (default: LuaLaTeX for non-Latin scripts)')
    args = parser.parse_args(argv)
    if not args.input.is_file():
        print(f'error: no file at {args.input}', file=sys.stderr)
        return 1
    if args.input.resolve() == args.output.resolve():
        print('error: write the output to a different file', file=sys.stderr)
        return 1
    text = args.input.read_text(encoding='utf-8', errors='replace')
    output, notes, scripts = clean(text, args.doc_class)
    args.output.write_text(output, encoding='utf-8')
    engine = args.engine or ('lualatex' if scripts else 'pdflatex')
    print(f'pandoc clean-up: wrote {args.output.name}')
    print('\n'.join(f'  - {note}' for note in notes))
    if scripts:
        names = ', '.join(name for name, _ in scripts)
        print(f'  - {names} text: compile with LuaLaTeX (babel onchar font switching)')
    report, code = check(args.output, engine=engine)
    print(report)
    return code


if __name__ == '__main__':
    sys.exit(main())
