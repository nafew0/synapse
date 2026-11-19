"""Tests for skill/academic-writing/scripts/check_draft.py.

Kept outside skill/ on purpose: every file in a skill directory is uploaded into each sandbox.
"""
import subprocess
import sys
from pathlib import Path

from docx import Document

SCRIPT = Path(__file__).resolve().parents[3] / 'skill' / 'academic-writing' / 'scripts' / 'check_draft.py'

AUTHOR_YEAR_MD = """# Introduction

Adaptation is understudied (Perera & Silva, 2020; see also Fernando et al., 2019a).
Gunawardena (2018) reported mixed results. Rainfall fell sharply [citation needed: rainfall decline in the dry zone].

## 2.1 Data

Data come from the World Health Organization (World Health Organization, 2021).

# References

Fernando, A., Lee, B., & Kim, C. (2019a). Title one. Journal, 1(2), 3-4.
Perera, K., & Silva, M. (2020). Title two. Journal of Things, 4, 1-9.
World Health Organization. (2021). Annual report.
Brown, T. (2015). Never cited. Journal.
"""

CLEAN_MD = """# Introduction

Uptake was low (Perera, 2020). Silva and Perera (2019) found the same pattern.

# References

Perera, K. (2020). Title. Journal.
Silva, M., & Perera, K. (2019). Title. Journal.
"""

NUMERIC_MD = """# Introduction

Earlier systems used rule-based parsing [1], [3-4]. Later work combined both [2, 4].

# References

[1] A. Perera, "Title one," Journal, 2020.
[2] B. Silva, "Title two," Journal, 2021.
[3] C. Fernando, "Title three," Journal, 2019.
[4] D. Kim, "Title four," Journal, 2018.
[5] E. Lee, "Never cited," Journal, 2017.
"""


def run(path, *args):
    return subprocess.run([sys.executable, SCRIPT, str(path), *args], capture_output=True, text=True)


def write(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text, encoding='utf-8')
    return path


def section_counts(stdout):
    lines = stdout.split('sections:\n', 1)[1].split('\ncitations:', 1)[0].splitlines()
    return {line.rsplit(':', 1)[0].strip(): int(line.rsplit(':', 1)[1]) for line in lines}


def test_author_year_matches_and_mismatches_in_markdown(tmp_path):
    result = run(write(tmp_path, 'draft.md', AUTHOR_YEAR_MD))

    assert result.returncode == 2, result.stdout + result.stderr
    assert 'checked as author-year' in result.stdout
    assert 'cited but not in references (1):\n  - Gunawardena 2018' in result.stdout
    assert 'in references but never cited (1):\n  - Brown, T. (2015)' in result.stdout
    assert 'Perera 2020' not in result.stdout
    assert 'reference list: 4 entries' in result.stdout


def test_clean_author_year_draft_passes(tmp_path):
    result = run(write(tmp_path, 'clean.md', CLEAN_MD))

    assert result.returncode == 0, result.stdout
    assert 'cited but not in references (0)' in result.stdout
    assert 'in references but never cited (0)' in result.stdout
    assert 'result: no issues' in result.stdout


def test_numeric_ranges_and_lists(tmp_path):
    result = run(write(tmp_path, 'ieee.md', NUMERIC_MD), '--style', 'ieee')

    assert result.returncode == 2
    assert 'checked as numeric' in result.stdout
    assert 'cited but not in references (0)' in result.stdout
    assert 'in references but never cited (1):\n  - [5] E. Lee' in result.stdout


def test_numeric_citation_without_entry(tmp_path):
    text = NUMERIC_MD.replace('[2, 4]', '[2, 4, 7]')
    result = run(write(tmp_path, 'ieee.md', text), '--style', 'numeric')

    assert 'cited but not in references (1):\n  - [7]' in result.stdout


def test_citation_needed_markers_and_placeholders_are_listed_but_not_issues(tmp_path):
    text = CLEAN_MD.replace(
        'Uptake was low (Perera, 2020).',
        'Uptake was low (Perera, 2020). Yield rose by XX% [citation needed: yield trend]. '
        'Costs were [...] and [citation needed: cost of inputs]. The sample was [n = ...].')
    result = run(write(tmp_path, 'markers.md', text))

    assert result.returncode == 0, result.stdout
    assert 'citation-needed markers: 2' in result.stdout
    assert '- [Introduction] yield trend' in result.stdout
    assert '- [Introduction] cost of inputs' in result.stdout
    assert 'placeholders: 3' in result.stdout


def test_novelty_claims_without_support_are_flagged(tmp_path):
    text = CLEAN_MD.replace(
        'Uptake was low (Perera, 2020).',
        'This is the first study to examine paddy insurance. The manuscript is submission-ready. '
        'A novel index was proposed earlier (Perera, 2020). '
        'No previous study has examined this [citation needed: absence of prior studies].')
    result = run(write(tmp_path, 'claims.md', text))

    assert result.returncode == 2
    assert 'unsupported novelty or readiness claims: 2' in result.stdout
    assert 'This is the first study to examine paddy insurance.' in result.stdout
    assert 'The manuscript is submission-ready.' in result.stdout
    assert 'A novel index' not in result.stdout


def test_word_counts_per_heading_in_markdown(tmp_path):
    text = '# Abstract\n\none two three four five\n\n# Methods\n\n## 3.1 Design\n\none two three\n'
    result = run(write(tmp_path, 'counts.md', text))

    counts = section_counts(result.stdout)
    assert counts == {'Abstract': 5, 'Methods': 0, '3.1 Design': 3}
    assert 'words: 8 (body 8, references 0)' in result.stdout
    assert 'reference list: none found' in result.stdout


def test_plain_text_headings_are_detected(tmp_path):
    text = ('1 INTRODUCTION\n\nUptake was low (Perera, 2020).\n\n'
            '3.2 Research design\n\nA cross-sectional survey was used.\n\n'
            'REFERENCES\n\nPerera, K. (2020). Title. Journal.\n')
    result = run(write(tmp_path, 'draft.txt', text))

    assert result.returncode == 0, result.stdout
    counts = section_counts(result.stdout)
    assert counts['1 INTRODUCTION'] == 5
    assert counts['3.2 Research design'] == 5
    assert counts['REFERENCES'] == 5


def build_docx(path, sections):
    document = Document()
    for title, level, paragraphs in sections:
        document.add_heading(title, level=level)
        for text in paragraphs:
            document.add_paragraph(text)
    document.save(path)
    return path


def test_docx_author_year_with_heading_styles(tmp_path):
    path = build_docx(tmp_path / 'chapter.docx', [
        ('Chapter 2 Literature Review', 1, [
            'Trust predicts adoption (Perera & Silva, 2020). Kim et al. (2019) disagree.',
            'This is the first study of its kind in Sri Lanka.',
        ]),
        ('2.1 Gap', 2, ['Few studies cover rural users [citation needed: rural coverage].']),
        ('References', 1, [
            'Perera, K., & Silva, M. (2020). Title. Journal.',
            'Zhou, L. (2017). Never cited. Journal.',
        ]),
    ])
    result = run(path, '--style', 'apa')

    assert result.returncode == 2
    assert 'cited but not in references (1):\n  - Kim 2019' in result.stdout
    assert 'in references but never cited (1):\n  - Zhou, L. (2017)' in result.stdout
    assert 'citation-needed markers: 1' in result.stdout
    assert 'unsupported novelty or readiness claims: 1' in result.stdout
    counts = section_counts(result.stdout)
    assert counts['Chapter 2 Literature Review'] == 23
    assert counts['2.1 Gap'] == 9


def test_docx_numeric_with_bold_headings_and_table(tmp_path):
    document = Document()
    heading = document.add_paragraph()
    heading.add_run('Introduction').bold = True
    document.add_paragraph('Earlier systems [1] and [2] differ.')
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = 'Comment'
    table.cell(0, 1).text = 'Addressed in [2].'
    references = document.add_paragraph()
    references.add_run('References').bold = True
    document.add_paragraph('[1] A. Perera, "Title," 2020.')
    document.add_paragraph('[2] B. Silva, "Title," 2021.')
    document.save(tmp_path / 'paper.docx')

    result = run(tmp_path / 'paper.docx')

    assert result.returncode == 0, result.stdout
    assert 'checked as numeric' in result.stdout
    assert section_counts(result.stdout)['Introduction'] == 10


def test_bad_arguments_exit_1(tmp_path):
    assert run(tmp_path / 'missing.docx').returncode == 1
    assert run(write(tmp_path, 'draft.pdf', 'x')).returncode == 1
    assert run(write(tmp_path, 'draft.md', CLEAN_MD), '--style', 'mla').returncode == 1
    assert subprocess.run([sys.executable, SCRIPT], capture_output=True).returncode == 1
