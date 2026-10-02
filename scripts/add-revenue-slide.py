"""
Appends the revenue-model slide to an existing Bhada-slides.pptx.

Separate from make-deck.py for the same reason add-closing-slide.py is: once a
human has typed the team names into the deck, regenerating it throws that work
away. So this opens the file that is already there, inserts one slide, and saves
it back. No existing slide is touched.

    python scripts/add-revenue-slide.py

The slide goes immediately before the closing slide, so the deck still ends on
the question mark and the QR code. Like the closing slide it carries no "n / 7"
page counter, because the seven numbered slides keep their own numbering.

Safe to run twice: it checks for the slide it adds and does nothing if it is
already present.
"""

import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
DECK = ROOT / "Bhada-slides.pptx"

INK = RGBColor(0x0F, 0x0E, 0x0C)
PANEL = RGBColor(0x17, 0x15, 0x0F)
RULE = RGBColor(0x2B, 0x27, 0x21)
RULE_HI = RGBColor(0x45, 0x3F, 0x34)
READ = RGBColor(0xEC, 0xE7, 0xD8)
DIM = RGBColor(0x8E, 0x87, 0x79)
PLATE = RGBColor(0xA8, 0x20, 0x2F)
LIVE = RGBColor(0x6F, 0xBF, 0x73)
CAUTION = RGBColor(0xE0, 0xA4, 0x37)

DISPLAY = "Bahnschrift SemiBold Condensed"
BODY = "Segoe UI"
MONO = "Consolas"

M = Inches(0.62)

MARKER = "We charge for the meter."
CLOSING_MARKER = "Any questions?"


def rect(s, x, y, w, h, fill=None, line=None):
    shape = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(0.75)
    shape.shadow.inherit = False
    return shape


def text(s, x, y, w, h, runs, align=PP_ALIGN.LEFT, spacing=None):
    box = s.shapes.add_textbox(x, y, w, h)
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.TOP
    paragraphs = runs if isinstance(runs[0], list) else [runs]
    for i, para in enumerate(paragraphs):
        p = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        p.alignment = align
        if spacing:
            p.space_after = spacing
        for content, size, colour, font, bold in para:
            r = p.add_run()
            r.text = content
            r.font.size = Pt(size)
            r.font.color.rgb = colour
            r.font.name = font
            r.font.bold = bold
    return box


def stat(s, x, y, w, value, unit, label, colour=READ):
    # The gap sits inside the large run: a space typed at 13pt between a 34pt
    # figure and its unit is too thin to read as a gap at all.
    text(s, x, y, w, Inches(0.8),
         [[(value + " ", 34, colour, DISPLAY, True), (unit, 13, DIM, BODY, False)]])
    text(s, x, y + Inches(0.56), w, Inches(0.6),
         [(label, 10.5, DIM, BODY, False)])


def build_revenue_slide(prs):
    """Where the money comes from, without taking any of the fare.

    The fare is a published tariff a regulator sets, so a startup that skims it
    is asking to be legislated out of existence. The three cards are therefore
    priced off the operator's side of the transaction — software, settlement,
    and later the data nobody in the country currently has — and the strip
    underneath shows what that is as a share of one bus's takings, so a judge
    can check the claim instead of believing it.
    """
    W, H = prs.slide_width, prs.slide_height

    s = prs.slides.add_slide(prs.slide_layouts[6])
    rect(s, 0, 0, W, H, fill=INK)

    rect(s, M, M + Inches(0.06), Inches(0.05), Inches(0.16), fill=PLATE)
    text(s, M + Inches(0.18), M, Inches(9), Inches(0.3),
         [("REVENUE MODEL", 11, DIM, BODY, False)])

    text(s, M, Inches(0.95), Inches(11.9), Inches(1.7),
         [[("We never touch the fare.", 44, READ, DISPLAY, True)],
          [(MARKER, 44, LIVE, DISPLAY, True)]])

    streams = [
        (LIVE, "SOFTWARE, PER BUS", "Rs 1,500", "/ month",
         "The meter, both door terminals, the operator dashboard."),
        (LIVE, "SETTLEMENT FEE", "1.5%", "of digital fares",
         "Only on money that moves through the rail. Cash rides cost nothing."),
        (CAUTION, "ROUTE DATA — YEAR 2", "Rs / km", "per route",
         "Earnings and load per kilometre. Nobody in Nepal sells this yet."),
    ]
    y = Inches(2.95)
    w = Inches(3.83)
    gap = Inches(0.2)
    for i, (accent, label, value, unit, body) in enumerate(streams):
        x = M + i * (w + gap)
        rect(s, x, y, w, Inches(1.95), fill=PANEL, line=RULE)
        rect(s, x, y, w, Inches(0.055), fill=accent)
        text(s, x + Inches(0.28), y + Inches(0.28), w - Inches(0.56), Inches(0.3),
             [(label, 10.5, DIM, BODY, True)])
        text(s, x + Inches(0.28), y + Inches(0.66), w - Inches(0.56), Inches(0.6),
             [[(value + " ", 34, accent, DISPLAY, True), (unit, 13, DIM, BODY, False)]])
        text(s, x + Inches(0.28), y + Inches(1.3), w - Inches(0.56), Inches(0.6),
             [(body, 12, DIM, BODY, False)])

    # What that is worth on one bus. Every figure below follows from the two
    # assumptions printed at the bottom of the slide.
    rect(s, M, Inches(5.2), W - 2 * M, Emu(9525), fill=RULE_HI)
    numbers = [
        ("Rs 150,000", "gross", "FARE PER BUS PER MONTH", READ),
        ("Rs 3,750", "to us", "2.5% OF THE FARE, ALL IN", LIVE),
        ("Rs 0", "hardware", "PHONES THEY ALREADY OWN", READ),
        ("Rs 2.25 cr", "a year", "AT 500 BUSES IN THE VALLEY", LIVE),
    ]
    nw = Inches(3.05)
    for i, (value, unit, label, colour) in enumerate(numbers):
        stat(s, M + i * (nw + Inches(0.12)), Inches(5.45), nw,
             value, unit, label, colour)

    text(s, M, Inches(6.3), Inches(11.9), Inches(0.35),
         [[("250 rides a day at Rs 20 average, one bus. ", 12, DIM, BODY, False),
           ("The operator pays us. The passenger never does.", 12, READ, BODY, False)]])

    rect(s, M, H - Inches(0.72), W - 2 * M, Emu(9525), fill=RULE)
    text(s, M, H - Inches(0.6), Inches(9), Inches(0.3),
         [("Revenue model", 9.5, DIM, BODY, False)])
    text(s, W - M - Inches(2.6), H - Inches(0.6), Inches(2.6), Inches(0.3),
         [("bhada-one.vercel.app", 9.5, DIM, MONO, False)], align=PP_ALIGN.RIGHT)

    # The deck this is appended to was saved without notes placeholders on its
    # layouts, so the frame is not always there to write into.
    frame = s.notes_slide.notes_text_frame
    if frame is not None:
        frame.text = (
            "Lead with the first line: we take none of the fare, because the fare is a "
            "published tariff and skimming it gets you regulated out of existence. Then "
            "the three cards — software, settlement, data. Land on Rs 3,750 a month per "
            "bus against Rs 150,000 of fare: two and a half percent, and no hardware to "
            "sell. If asked, the assumptions are printed on the slide."
        )
    return s


def already_present(prs):
    for slide in prs.slides:
        for shape in slide.shapes:
            if shape.has_text_frame and MARKER in shape.text_frame.text:
                return True
    return False


def closing_slide_index(prs):
    """Index of the 'Any questions?' slide, or None if it is not in the deck."""
    for i, slide in enumerate(prs.slides):
        for shape in slide.shapes:
            if shape.has_text_frame and CLOSING_MARKER in shape.text_frame.text:
                return i
    return None


def move_before(prs, from_index, to_index):
    """python-pptx appends; the slide order lives in a list we can reorder."""
    id_list = prs.slides._sldIdLst
    entries = list(id_list)
    entry = entries[from_index]
    id_list.remove(entry)
    id_list.insert(to_index, entry)


def main():
    if not DECK.exists():
        print(f"{DECK.name} not found. Run make-deck.py first.")
        return 1

    prs = Presentation(str(DECK))
    if already_present(prs):
        print("revenue slide already there — nothing to do")
        return 0

    before = len(prs.slides._sldIdLst)
    build_revenue_slide(prs)

    closing = closing_slide_index(prs)
    if closing is not None:
        move_before(prs, before, closing)

    try:
        prs.save(str(DECK))
    except PermissionError:
        print(f"{DECK.name} is open in PowerPoint. Close it and run this again.")
        return 1
    print(f"added the revenue slide — {before} slides in, {before + 1} out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
