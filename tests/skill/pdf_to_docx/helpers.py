"""Fixture builders shared by the pdf-to-docx tests.

Kept beside the tests rather than in `skill/pdf-to-docx/`: every file in a deployment skill
directory is uploaded into each user's code sandbox.
"""
import importlib.util
import sys
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'pdf-to-docx' / 'scripts'
WIDTH, HEIGHT = A4
BENGALI_FONT = 'NotoSansBengali'
BENGALI_CANDIDATES = (
    '/usr/share/fonts/google-noto-vf/NotoSansBengali[wght].ttf',
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
    '/usr/share/fonts/google-noto/NotoSansBengali-Regular.ttf',
)


def load(name):
    """Import a skill script by path — the scripts run from `/mnt/data/skills/`, not a package.

    One instance per name, shared by every test module. Loading a second copy gives the scripts
    two `probe` modules: the one a test monkeypatches and the one `verify_conversion` actually
    calls, and the patch silently does nothing.
    """
    path = SCRIPTS / f'{name}.py'
    cached = sys.modules.get(name)
    if cached is not None and getattr(cached, '__file__', None) == str(path):
        return cached
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def build_pdf(path, pages, pagesize=(WIDTH, HEIGHT)):
    from reportlab.pdfgen import canvas

    page = canvas.Canvas(str(path), pagesize=pagesize)
    for draw in pages:
        draw(page)
        page.showPage()
    page.save()
    return path


def bengali_font():
    """The registered Bangla font name, or None when no Bengali font is installed."""
    for candidate in BENGALI_CANDIDATES:
        if not Path(candidate).is_file():
            continue
        if BENGALI_FONT not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(BENGALI_FONT, candidate))
        return BENGALI_FONT
    return None


def make_logo(path, size=120):
    """A crest-like mark: solid enough that a converter cannot silently drop it."""
    image = Image.new('RGB', (size, size), 'white')
    draw = ImageDraw.Draw(image)
    draw.ellipse((4, 4, size - 4, size - 4), fill=(12, 74, 134))
    draw.ellipse((size * 0.3, size * 0.3, size * 0.7, size * 0.7), fill='white')
    image.save(path)
    return path


def make_signature(path, width=260, height=90):
    image = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(image)
    draw.line([(16, 70), (70, 20), (120, 72), (180, 18), (240, 60)], fill=(20, 20, 90), width=4)
    image.save(path)
    return path


def make_qr(path, payload):
    qrcode.make(payload).convert('RGB').save(path)
    return path
