"""A scanned page's tilt and turn, measured from its ink with OpenCV.

page_tilt      the small angle a crooked scan leans by: the page is turned in fine steps and the
               angle at which its rows of ink line up sharpest wins.
word_direction which way a Bangla page was turned: each Bangla word is one piece of ink joined by
               its headline, so the pieces are wide when the page is upright and tall when it lies
               sideways, and the inkiest row of each sits at its top when the page is not upside down.

Measured on real notices, a phone photo and a 22-page sideways table (docs/ocr-benchmark/turns.py):
tilt within 0.6 degrees, every turn right. Without OpenCV both give no answer.
"""

from math import cos, radians, sin
from statistics import median

try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = None

TILT_WIDTH = 1000
MAX_TILT = 10.0
COARSE_STEP = 0.5
FINE_STEP = 0.05
WORD_WIDTH = 1600
RULE_SHARE = 15
LONG_RULE_SHARE = 1 / 3
MIN_RULES = 2
MIN_WORD_ROWS = 8
MIN_WORD_AREA = MIN_WORD_ROWS * 3
WORD_SHAPE = 1.8
MIN_WORDS = 20
HEADLINE_MARGIN = 0.08


def binary_ink(image, width):
    """White ink on black at a working width."""
    gray = np.asarray(image.convert("L"))
    scale = width / gray.shape[1]
    small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    _, binary = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return binary


def rules(binary):
    """The straight runs of ink across and down: a table's ruled lines (and a few headlines)."""
    height, width = binary.shape
    across = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(width // RULE_SHARE, 3), 1)))
    down = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(height // RULE_SHARE, 3))))
    return across, down


def ink(image, width):
    """The ink without a table's ruled lines, which otherwise outweigh the text."""
    binary = binary_ink(image, width)
    across, down = rules(binary)
    return cv2.subtract(binary, cv2.bitwise_or(across, down))


def long_rules(across):
    """Only the ruled lines that run a good part of the page's width, or None when there are too
    few to trust. A slightly tilted rule survives the straight opening as touching steps, so it is
    still one piece; a word's headline is far shorter."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(across, connectivity=8)
    width = across.shape[1]
    keep = [index for index in range(1, count) if stats[index][2] >= width * LONG_RULE_SHARE]
    if len(keep) < MIN_RULES:
        return None
    return np.where(np.isin(labels, keep), 255, 0).astype(np.uint8)


def rotated(binary, angle):
    height, width = binary.shape
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    return cv2.warpAffine(binary, matrix, (width, height), flags=cv2.INTER_NEAREST, borderValue=0)


def sharpness(binary):
    """How cleanly the ink falls into rows: lines of text and the gaps between give a spiky profile."""
    rows = binary.sum(axis=1, dtype=np.float64)
    return float(np.square(np.diff(rows)).sum())


def best_angle(binary, angles):
    return max(angles, key=lambda angle: (sharpness(rotated(binary, angle)), -abs(angle)))


def page_tilt(image):
    """Degrees the page's lines lean counterclockwise (turning the picture by minus that much
    straightens it), or None without OpenCV. A ruled table is measured by its rules: the text in
    its narrow cells does not share baselines across columns and can lean the wrong way."""
    if cv2 is None:
        return None
    binary = binary_ink(image, TILT_WIDTH)
    across, down = rules(binary)
    ruled = long_rules(across)
    binary = ruled if ruled is not None else cv2.subtract(binary, cv2.bitwise_or(across, down))
    coarse = best_angle(binary, np.arange(-MAX_TILT, MAX_TILT + 1e-9, COARSE_STEP))
    fine = best_angle(binary, np.arange(coarse - COARSE_STEP, coarse + COARSE_STEP + 1e-9, FINE_STEP))
    return -round(float(fine), 2)


def word_direction(image):
    """(direction, sure): how the page must be turned to stand upright, in text_direction's words
    (None when it is upright), and whether the words said so clearly. (None, False) when there are
    too few Bangla words to tell, or no OpenCV."""
    if cv2 is None:
        return None, False
    binary = ink(image, WORD_WIDTH)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    pieces = [(index, *stats[index][:4]) for index in range(1, count) if stats[index][4] >= MIN_WORD_AREA]
    wide = [p for p in pieces if p[3] >= WORD_SHAPE * p[4] and p[4] >= MIN_WORD_ROWS]
    tall = [p for p in pieces if p[4] >= WORD_SHAPE * p[3] and p[3] >= MIN_WORD_ROWS]
    if max(len(wide), len(tall)) < MIN_WORDS:
        return None, False
    sideways = len(tall) > len(wide)
    places = []
    for index, x, y, w, h in tall if sideways else wide:
        profile = (labels[y : y + h, x : x + w] == index).sum(axis=0 if sideways else 1)
        places.append(int(np.argmax(profile)) / max(len(profile) - 1, 1))
    place = median(places)
    sure = abs(place - 0.5) >= HEADLINE_MARGIN
    if sideways:
        return ("clockwise" if place < 0.5 else "counterclockwise"), sure
    return (None if place < 0.5 else "upside_down"), sure


def turn_about_center(point, angle, width, height):
    """Where a point goes when the picture is turned `angle` degrees counterclockwise about its
    center, as PIL's Image.rotate does without expanding."""
    x, y = point[0] - width / 2, point[1] - height / 2
    a = radians(angle)
    return [width / 2 + x * cos(a) + y * sin(a), height / 2 - x * sin(a) + y * cos(a)]
