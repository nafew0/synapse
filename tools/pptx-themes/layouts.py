"""Write a deck with one slide per layout, each placeholder labelled with its index and type.

    python3 layouts.py <template.pptx> <out.pptx>
"""

import sys

from pptx import Presentation


def main(source, target):
    presentation = Presentation(source)
    layouts = [(m, l, layout) for m, master in enumerate(presentation.slide_masters) for l, layout in enumerate(master.slide_layouts)]
    for m, l, layout in layouts:
        slide = presentation.slides.add_slide(layout)
        for shape in slide.placeholders:
            kind = str(shape.placeholder_format.type).split(".")[-1].split(" ")[0]
            if shape.has_text_frame:
                shape.text_frame.text = f"M{m}L{l} {layout.name} | {shape.placeholder_format.idx} {kind} বাংলা লেখা"
    keep = len(layouts)
    slides = presentation.slides._sldIdLst
    for entry in list(slides)[:-keep]:
        slides.remove(entry)
    presentation.save(target)


if __name__ == "__main__":
    main(*sys.argv[1:3])
