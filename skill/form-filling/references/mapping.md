# Mapping JSON

`fill.py` and `check.py` read the same file. The form kind (fillable PDF, flat PDF, Word) comes from
the form itself, so one schema covers all three; only the overlay route needs positions.

```json
{
  "language": "bn",
  "bangla_font": "Nikosh",
  "fields": [
    {"id": "…", "label": "…", "value": "…", "source": "…", "required": true}
  ],
  "blank_reasons": {"<id>": "why it is empty"}
}
```

| Key | Where | Meaning |
|---|---|---|
| `fields` | top | One entry per form field you considered, including the ones you leave blank. |
| `id` | entry | Exactly as `fields.py` printed it. For the overlay route, any unique name. |
| `label` | entry | The form's label, copied from `fields.py`; used in reports. |
| `value` | entry | Text, or `true`/`false` for a tick box. `""` means left blank. `\n` makes a new line. |
| `source` | entry | Where the value came from: `"CV.pdf p1"`, `"certificate.jpg"`, `"user message"`, `"user message (earlier)"`. Required for every non-empty value. |
| `required` | entry | `true` when the form marks the field required. A required field must be filled or have a `blank_reasons` entry, or `check.py` fails. |
| `blank_reasons` | top | Id → reason for every field left blank: `"not in any attached document"`, `"not provided"`, `"signature: signed by hand"`. |
| `bangla_font` | top | Font for Bangla text (default `Nikosh`). For overlays it may also be a `.ttf` path. |
| `language` | top | Optional note of the form's language; not used by the scripts. |

Only `fields`, `id` and `value` are read by `fill.py`; `source` is for you and the reply, and is what
keeps a value honest. A value you cannot give a source for is a value you invented: leave it blank.

## Fillable PDF

Ids are the AcroForm field names. Tick boxes take `true`/`false`; radio groups take the option
(`"female"` or `"/female"`); choice fields take an option's text or export value.

```json
{
  "fields": [
    {"id": "applicant.name", "label": "Full name", "value": "Dr. Rahima Khatun", "source": "CV.pdf p1", "required": true},
    {"id": "citizen", "label": "Bangladeshi citizen", "value": true, "source": "NID card"},
    {"id": "category", "label": "Category", "value": "Arts & Culture", "source": "user message"},
    {"id": "gender", "label": "Gender", "value": "female", "source": "CV.pdf p1"},
    {"id": "dob", "label": "Date of birth", "value": "", "required": true}
  ],
  "blank_reasons": {"dob": "not in any attached document"}
}
```

Text that needs more room than its box is reported as an overflow (exit 2): shorten it, or for a
narrative field move the detail to an attached sheet and write "see attached".

## Flat or scanned PDF (overlay)

Each entry also needs `page` (1-based), `x`, `y`, and optionally `size` (pt, default 10), `width`
(wraps the text) and `height` (overflow check). Coordinates are PDF points with the origin at the
**bottom left** and `y` on the text **baseline**. `fields.py` lists candidate blanks (underscore runs
and drawn lines) in exactly these units: copy their `x`, `y`, `width`.

```json
{
  "fields": [
    {"id": "name", "label": "Name of applicant", "value": "Dr. Rahima Khatun", "source": "CV.pdf p1",
     "page": 1, "x": 153.4, "y": 761, "size": 10, "width": 200},
    {"id": "institution", "label": "Institution", "value": "ঢাকা বিশ্ববিদ্যালয়", "source": "CV.pdf p1",
     "page": 1, "x": 132, "y": 721, "size": 11},
    {"id": "contribution", "label": "Contribution", "value": "Forty years of research on …",
     "source": "CV.pdf p2-3", "page": 2, "x": 60, "y": 640, "size": 10, "width": 470, "height": 180},
    {"id": "female", "label": "Female", "value": true, "type": "check", "source": "CV.pdf p1",
     "page": 1, "x": 312, "y": 683, "size": 10},
    {"id": "signature", "label": "Signature", "value": "", "required": true}
  ],
  "blank_reasons": {"signature": "must be signed by hand"}
}
```

A tick (`true`) is drawn as a check mark at `x, y`; `false` draws nothing.

**Scanned pages: pixel units.** When the positions come from a page image, set `"units": "px"` and
the `dpi` the image was rendered at; `x`, `y`, `width` and `height` are then pixels with the origin
at the **top left** (as an image viewer shows them), `y` still on the baseline:

```json
{"units": "px", "dpi": 100,
 "fields": [{"id": "name", "value": "Dr. Rahima Khatun", "source": "CV.pdf p1", "page": 1, "x": 214, "y": 228, "size": 10}]}
```

Render with `pdftoppm -r 100 -png -f 1 -l 1 FORM.pdf /mnt/data/qa/page` so the dpi matches. The
conversion is `x_pt = x_px × 72 / dpi`, `y_pt = page_height − y_px × 72 / dpi`.

`check.py` fails an overlay that is off the page, overflows its `height`, or covers a printed word,
so a misplaced value is caught before the render.

## Word (.docx)

Ids from `fields.py`:

| Id | Place | Written as |
|---|---|---|
| `t0.r2.c1` | Empty (or `____`) table cell; label from the cell to its left or the column header | the cell's text, in the cell's run formatting; `\n` becomes a line break |
| `t0.r1.c0.p0.b0` | `____` or `……` blank inside a table cell's paragraph | replaces the blank in place |
| `p7.b1` | Second blank in body paragraph 7 (`Name: ______  Date: ______`) | replaces the blank; `\n` becomes a space |
| `p9.x0` | First ☐ in body paragraph 9 | `true` → ☒, `false` → ☐ |
| `sdt3` | Content control (plain text, date, drop-down, check box) | replaces the placeholder; drop-downs take an option's text |

```json
{
  "bangla_font": "Nikosh",
  "fields": [
    {"id": "t0.r0.c1", "label": "মনোনীত ব্যক্তির নাম", "value": "ড. রহিমা খাতুন", "source": "CV.pdf p1", "required": true},
    {"id": "t0.r1.c1", "label": "অবদানের ক্ষেত্র", "value": "সাহিত্য", "source": "user message"},
    {"id": "t0.r2.c1", "label": "জন্ম তারিখ", "value": "", "required": true},
    {"id": "t2.r1.c1", "label": "Degree (row 1)", "value": "PhD", "source": "certificate-phd.pdf"},
    {"id": "p12.b0", "label": "Nominated by", "value": "Bangla Academy", "source": "user message"},
    {"id": "p14.x1", "label": "Organisation", "value": true, "source": "user message"},
    {"id": "sdt0", "label": "Category", "value": "Literature", "source": "user message"}
  ],
  "blank_reasons": {"t0.r2.c1": "not in any attached document"}
}
```

Bangla values get the `bangla_font` in the run's complex-script slot (`w:cs`) and `bn-BD` as the
complex-script language; `check.py` fails a Bangla run without it. Word table rows grow to fit, so
long cell text never overflows; a value much longer than its underscore blank is noted because the
line will wrap.
