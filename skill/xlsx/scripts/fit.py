"""Find cell contents that do not fit the column widths and row heights the sheet already has.

Excel measures a column width in digits of the workbook's default font that fit inside the
cell's padding, so text is measured in the same unit: each character counts as its typical width
relative to a digit, scaled by the cell's font size. The estimate needs no font files, so it gives
the same answer in a sandbox that lacks the workbook's fonts as on the user's machine, and it is
only accurate to about a tenth; the tolerances below absorb that.

A fit problem is what the reader sees on the printed form:
- a number wider than its column prints as ####;
- text wider than its cell is cut off when the cell is merged or its neighbour is not empty;
- wrapped text needing more lines than the row is tall loses its last lines, unless Excel can
  grow the row: one without a custom height, holding no merged range.
"""
from datetime import date, datetime, time

from openpyxl.utils import get_column_letter

NARROW = set("iljtfrI.,:;'|!()[]{} -")
WIDE = set('mwMW@%&')
UPPER_RATIO = 1.15
NARROW_RATIO = 0.5
WIDE_RATIO = 1.5
LOWER_RATIO = 0.95
BOLD_RATIO = 1.07
LINE_HEIGHT = 1.3
DEFAULT_COLUMN_WIDTH = 8.43
DEFAULT_ROW_HEIGHT = 15.0
DEFAULT_FONT_SIZE = 11.0
TEXT_TOLERANCE = 1.15
NUMBER_TOLERANCE = 1.02
HEIGHT_TOLERANCE = 1.1
SPILL_RIGHT = {None, 'general', 'left', 'fill', 'justify', 'distributed'}
SPILL_LEFT = {'right'}


def char_width(char):
    if char.isdigit():
        return 1.0
    if char in NARROW:
        return NARROW_RATIO
    if char in WIDE:
        return WIDE_RATIO
    if char.isupper():
        return UPPER_RATIO
    return LOWER_RATIO


def text_width(text, font_size, bold, base_size):
    """Width of `text` in column-width units (digits of the default font)."""
    scale = (font_size or base_size) / base_size * (BOLD_RATIO if bold else 1.0)
    return sum(char_width(char) for char in text) * scale


def section(number_format, value):
    sections = number_format.split(';')
    if value < 0 and len(sections) > 1:
        return sections[1]
    if value == 0 and len(sections) > 2:
        return sections[2]
    return sections[0]


def literal_text(fmt):
    """The characters a format prints around the number: quoted text, escapes, currency."""
    out, quoted, index = [], False, 0
    while index < len(fmt):
        char = fmt[index]
        if char == '"':
            quoted = not quoted
        elif quoted:
            out.append(char)
        elif char == '\\' and index + 1 < len(fmt):
            index += 1
            out.append(fmt[index])
        elif char == '_' and index + 1 < len(fmt):
            index += 1
            out.append(' ')
        elif char == '*' and index + 1 < len(fmt):
            index += 1
        elif char == '[':
            end = fmt.find(']', index)
            symbol = fmt[index + 1:end].split('-')[0].lstrip('$') if end > index else ''
            out.append(symbol if fmt[index + 1:index + 2] == '$' else '')
            index = end if end > index else index
        elif char in '$-+()/: ':
            out.append(char)
        index += 1
    return ''.join(out)


def render_number(value, number_format):
    """Roughly what Excel prints for a number, or None when it would shrink instead of ####."""
    fmt = number_format or 'General'
    if fmt == 'General':
        return None
    part = section(fmt, value)
    code = ''.join(char for char in ''.join(part.split('"')[::2]) if char in '0#?.,%')
    shown = abs(value) * (100 if '%' in code else 1)
    decimals = len(code.split('.', 1)[1].rstrip(',%').replace('#', '0').replace('?', '0')) if '.' in code else 0
    digits = f'{shown:,.{decimals}f}' if ',' in code else f'{shown:.{decimals}f}'
    sign = '-' if value < 0 and len(fmt.split(';')) == 1 else ''
    return sign + digits + ('%' if '%' in code else '') + literal_text(part)


def general_integer(value):
    """General shrinks decimals to fit, then switches to scientific; the integer part is the floor."""
    return f'{int(abs(value))}' + ('-' if value < 0 else '')


def display(value, number_format):
    """(text, is_number) for how the cell reads on screen, or None when there is nothing to check."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (datetime, date, time)):
        fmt = (number_format or '').split(';')[0]
        return ''.join(char for char in fmt if char not in '"\\[]') or '00/00/0000', True
    if isinstance(value, (int, float)):
        text = render_number(value, number_format)
        return (text if text is not None else general_integer(value)), True
    text = str(value)
    return (text if not text.startswith('=') else None), False


class Geometry:
    """Column widths and row heights of one sheet, with merged ranges resolved."""

    def __init__(self, ws):
        self.ws = ws
        self.default_width = ws.sheet_format.defaultColWidth or DEFAULT_COLUMN_WIDTH
        self.default_height = ws.sheet_format.defaultRowHeight or DEFAULT_ROW_HEIGHT
        self.merged = {}
        for merged in ws.merged_cells.ranges:
            self.merged[(merged.min_row, merged.min_col)] = merged
        self.covered = {
            (row, col)
            for merged in ws.merged_cells.ranges
            for row in range(merged.min_row, merged.max_row + 1)
            for col in range(merged.min_col, merged.max_col + 1)
        }

    def width(self, col):
        dim = self.ws.column_dimensions.get(get_column_letter(col))
        if dim is None:
            return self.default_width
        if dim.hidden:
            return 0.0
        return dim.width or self.default_width

    def height(self, row):
        dim = self.ws.row_dimensions.get(row)
        if dim is None:
            return self.default_height
        if dim.hidden:
            return 0.0
        return dim.height or self.default_height

    def grows(self, row):
        """Excel sizes a row without a custom height to its wrapped text; never a merged range."""
        dim = self.ws.row_dimensions.get(row)
        return dim is None or not dim.customHeight

    def box(self, row, col):
        """(width units, height points, merged) available to the cell at row, col."""
        merged = self.merged.get((row, col))
        if merged is None:
            return self.width(col), self.height(row), False
        width = sum(self.width(c) for c in range(merged.min_col, merged.max_col + 1))
        height = sum(self.height(r) for r in range(merged.min_row, merged.max_row + 1))
        return width, height, True

    def is_empty(self, row, col, values):
        if col < 1 or (row, col) in self.covered:
            return False
        return values.get((row, col)) in (None, '')


def wrapped_lines(text, width, size, bold, base_size):
    lines = 0
    for paragraph in text.split('\n'):
        lines += 1
        current = 0.0
        for word in paragraph.split(' '):
            word_width = text_width(word + ' ', size, bold, base_size)
            if current and current + word_width > width:
                lines += 1
                current = word_width
            else:
                current += word_width
    return lines


def spills(cell, geometry, values):
    """Whether text too wide for its cell can run on into the empty cells beside it."""
    row, col, horizontal = cell.row, cell.column, cell.alignment.horizontal
    if horizontal in SPILL_RIGHT:
        return geometry.is_empty(row, col + 1, values)
    if horizontal in SPILL_LEFT:
        return geometry.is_empty(row, col - 1, values)
    return geometry.is_empty(row, col - 1, values) and geometry.is_empty(row, col + 1, values)


def cell_problem(cell, value, geometry, values, base_size):
    """A description of how `value` fails to fit `cell`, or None when it fits."""
    shown = display(value, cell.number_format)
    if shown is None:
        return None
    text, is_number = shown
    font, alignment = cell.font, cell.alignment
    size = float(font.sz or base_size)
    width, height, merged = geometry.box(cell.row, cell.column)

    if alignment.wrap_text and not is_number:
        if not merged and geometry.grows(cell.row):
            return None
        lines = wrapped_lines(text, width, size, font.b, base_size)
        needed = lines * size * LINE_HEIGHT
        if needed > height * HEIGHT_TOLERANCE:
            return f'wrapped text needs {lines} line(s), about {needed:.0f}pt, but the row is {height:.0f}pt tall'
        return None

    needed = text_width(text.replace('\n', ' '), size, font.b, base_size)
    if is_number:
        if needed > width * NUMBER_TOLERANCE:
            return f'{text!r} needs a width of about {needed:.1f} but the column is {width:.1f}, so it prints as ####'
        return None
    if needed <= width * TEXT_TOLERANCE:
        return None
    if merged or not spills(cell, geometry, values):
        return f'text needs a width of about {needed:.1f} but the cell is {width:.1f}, so it is cut off'
    return None


def base_font_size(wb):
    fonts = getattr(wb, '_fonts', None)
    size = fonts[0].sz if fonts else None
    return float(size or DEFAULT_FONT_SIZE)


def fit_problems(ws, values_ws, base_size):
    """{coordinate: description} for every cell whose content does not fit. `values_ws` is the
    same sheet loaded with data_only=True, so formula results are measured too."""
    values = {(c.row, c.column): c.value for c in values_ws._cells.values()}
    geometry = Geometry(ws)
    problems = {}
    for cell in ws._cells.values():
        if (cell.row, cell.column) in geometry.covered and (cell.row, cell.column) not in geometry.merged:
            continue
        value = values.get((cell.row, cell.column))
        if value is None and isinstance(cell.value, str) and cell.value.startswith('='):
            continue
        problem = cell_problem(cell, value if value is not None else cell.value, geometry, values, base_size)
        if problem:
            problems[cell.coordinate] = problem
    return problems
