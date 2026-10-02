"""
Builds the slide deck: Bhada-slides.pptx, seven slides, 16:9.

Generated rather than hand-drawn for the same reason the fare table is generated
from the stop order: the deck quotes numbers that live in the code, and two
copies of a number eventually disagree. Re-run this after changing the tariff.

    python scripts/make-deck.py

The slides carry almost no prose, on purpose. A judge cannot read a paragraph and
listen to a person at the same time, and if they can read the slide they will
stop listening to you. So the screen holds the headline and the numbers, and the
words you actually say live in scripts/pitch.py, which builds the script PDF.

Fonts: Bahnschrift (condensed, ships with Windows 10/11) for display, Segoe UI
for body, Nirmala UI for Devanagari. On a Mac these fall back; the layout is
built from shapes and absolute positions, so a fallback changes the texture and
not the structure.
"""

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "Bhada-slides.pptx"

# The palette from src/styles/meter.css. An instrument panel, not a slide theme.
INK = RGBColor(0x0F, 0x0E, 0x0C)
PANEL = RGBColor(0x17, 0x15, 0x0F)
RULE = RGBColor(0x2B, 0x27, 0x21)
RULE_HI = RGBColor(0x45, 0x3F, 0x34)
READ = RGBColor(0xEC, 0xE7, 0xD8)
DIM = RGBColor(0x8E, 0x87, 0x79)
PLATE = RGBColor(0xA8, 0x20, 0x2F)
LIVE = RGBColor(0x6F, 0xBF, 0x73)
CAUTION = RGBColor(0xE0, 0xA4, 0x37)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

DISPLAY = "Bahnschrift SemiBold Condensed"
BODY = "Segoe UI"
DEVA = "Nirmala UI"
MONO = "Consolas"

W = Inches(13.333)
H = Inches(7.5)
M = Inches(0.62)


# --------------------------------------------------------------------- helpers

def deck():
    prs = Presentation()
    prs.slide_width = W
    prs.slide_height = H
    return prs


def slide(prs, ground=INK):
    s = prs.slides.add_slide(prs.slide_layouts[6])  # blank
    bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, W, H)
    bg.fill.solid()
    bg.fill.fore_color.rgb = ground
    bg.line.fill.background()
    bg.shadow.inherit = False
    return s


def rect(s, x, y, w, h, fill=None, line=None, width=Pt(0.75)):
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
        shape.line.width = width
    shape.shadow.inherit = False
    return shape


def text(s, x, y, w, h, runs, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=None):
    """runs: list of (string, size_pt, colour, font, bold), or a list of such
    lists, one inner list per paragraph."""
    box = s.shapes.add_textbox(x, y, w, h)
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = anchor

    paragraphs = runs if isinstance(runs[0], list) else [runs]
    for i, para_runs in enumerate(paragraphs):
        p = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        p.alignment = align
        if spacing:
            p.space_after = spacing
        for content, size, colour, font, bold in para_runs:
            r = p.add_run()
            r.text = content
            r.font.size = Pt(size)
            r.font.color.rgb = colour
            r.font.name = font
            r.font.bold = bold
    return box


def kicker(s, label, y=M):
    rect(s, M, y + Inches(0.06), Inches(0.05), Inches(0.16), fill=PLATE)
    text(s, M + Inches(0.18), y, Inches(9), Inches(0.3),
         [(label.upper(), 11, DIM, BODY, False)])


def heading(s, line1, line2=None, y=Inches(0.95), accent=None, size=44):
    """One idea, two lines at most. If it needs three, it is not a headline."""
    runs = [[(line1, size, READ, DISPLAY, True)]]
    if line2:
        runs.append([(line2, size, accent or PLATE, DISPLAY, True)])
    return text(s, M, y, Inches(11.9), Inches(1.7), runs)


def footer(s, page, label):
    rect(s, M, H - Inches(0.72), W - 2 * M, Emu(9525), fill=RULE)
    text(s, M, H - Inches(0.6), Inches(8), Inches(0.3),
         [(label, 9.5, DIM, BODY, False)])
    text(s, W - M - Inches(1.2), H - Inches(0.6), Inches(1.2), Inches(0.3),
         [(f"{page} / 7", 9.5, DIM, MONO, False)], align=PP_ALIGN.RIGHT)


def notes(s, body):
    s.notes_slide.notes_text_frame.text = body


def stat(s, x, y, w, value, unit, label, colour=READ):
    text(s, x, y, w, Inches(0.8),
         [[(value, 40, colour, DISPLAY, True), (unit, 15, DIM, BODY, False)]])
    text(s, x, y + Inches(0.64), w, Inches(0.6),
         [(label, 11, DIM, BODY, False)])


# ------------------------------------------------------------------- 1. cover

def cover(prs):
    s = slide(prs)

    # Number plate, drawn rather than pictured: it is the one object every
    # Nepali bus already carries, and the product is named after the fare
    # painted beside it.
    rect(s, M, Inches(1.05), Inches(3.05), Inches(1.15), fill=PLATE)
    text(s, M + Inches(0.2), Inches(1.2), Inches(2.8), Inches(0.9),
         [[("बा २ ख ", 34, WHITE, DEVA, True), ("4412", 34, WHITE, DISPLAY, True)]])

    text(s, M, Inches(2.4), Inches(8.4), Inches(1.5), [[("भाडा", 80, READ, DEVA, True)]])
    text(s, M, Inches(3.62), Inches(8.4), Inches(0.6),
         [[("BHADA", 30, PLATE, DISPLAY, True)]])

    text(s, M, Inches(4.45), Inches(7.8), Inches(1.3),
         [[("Bus fare by the kilometre.", 30, READ, DISPLAY, True)],
          [("Works with no signal.", 30, READ, DISPLAY, True)]])

    x = Inches(8.7)
    rect(s, x, Inches(1.05), Inches(4.02), Inches(3.9), fill=PANEL, line=RULE_HI)
    text(s, x + Inches(0.3), Inches(1.3), Inches(3.4), Inches(0.3),
         [("LIVE READOUT", 10, DIM, BODY, False)])
    stat(s, x + Inches(0.3), Inches(1.7), Inches(1.7), "4.31", " km", "ODOMETER")
    stat(s, x + Inches(2.2), Inches(1.7), Inches(1.7), "22", " / 42", "ABOARD")
    stat(s, x + Inches(0.3), Inches(2.9), Inches(1.7), "21", " NPR", "THIS RIDE", LIVE)
    stat(s, x + Inches(2.2), Inches(2.9), Inches(1.7), "0", " disputes", "TODAY")
    rect(s, x + Inches(0.3), Inches(4.15), Inches(3.42), Inches(0.5), fill=INK, line=RULE)
    text(s, x + Inches(0.45), Inches(4.28), Inches(3.2), Inches(0.3),
         [("015c0004 0004 116401a6 81540516", 11, LIVE, MONO, False)])

    text(s, M, Inches(6.2), Inches(11.9), Inches(0.5),
         [[("[Name]   ·   [Name]   ·   [Name]   ·   [Name]", 14, DIM, BODY, False)]])

    footer(s, 1, "Bhada")
    notes(s, "Say: this is Bhada, it charges bus fare by the kilometre you actually "
             "travel, and it works with no mobile network. Then stop and click.")


# ----------------------------------------------------------------- 2. problem

def problem(prs):
    s = slide(prs)
    kicker(s, "The problem")
    heading(s, "Nepali buses have", "no bus stops.")

    facts = [("2.9 km", "Rs 25"), ("7.5 km", "Rs 25")]
    w = Inches(3.83)
    for i, (top, bottom) in enumerate(facts):
        x = M + i * (w + Inches(0.2))
        rect(s, x, Inches(3.2), w, Inches(2.0), fill=PANEL, line=RULE)
        text(s, x + Inches(0.35), Inches(3.5), w - Inches(0.7), Inches(1.4),
             [[(top, 40, READ, DISPLAY, True)], [(bottom, 40, PLATE, DISPLAY, True)]])

    x = M + 2 * (w + Inches(0.2))
    rect(s, x, Inches(3.2), w, Inches(2.0), fill=PANEL, line=PLATE)
    text(s, x + Inches(0.35), Inches(3.5), w - Inches(0.7), Inches(1.4),
         [[("Same bus.", 40, READ, DISPLAY, True)], [("Same price.", 40, READ, DISPLAY, True)]])

    text(s, M, Inches(5.6), Inches(11.9), Inches(0.9),
         [[("Nobody knows how far you went. So the fare is a guess.", 22, READ, DISPLAY, True)],
          [("Three digital ticketing rollouts in Nepal have already been abandoned.",
            14, DIM, BODY, False)]], spacing=Pt(8))

    footer(s, 2, "Problem")
    notes(s, "The two cards are the whole argument. 2.9 km costs the same as 7.5 km, "
             "because the fare is priced stop to stop and there are no stops.")


# ---------------------------------------------------------------- 3. solution

def solution(prs):
    s = slide(prs)
    kicker(s, "Our solution")
    heading(s, "One box under the seat.", "It measures the ride.")

    chips = [
        ("Charges per kilometre", LIVE),
        ("Works with no internet", LIVE),
        ("Locks the door when full", CAUTION),
    ]
    for i, (label, colour) in enumerate(chips):
        yy = Inches(3.2) + i * Inches(0.88)
        rect(s, M, yy, Inches(0.06), Inches(0.55), fill=colour)
        text(s, M + Inches(0.32), yy + Inches(0.02), Inches(5.7), Inches(0.6),
             [(label, 26, READ, DISPLAY, True)])

    # A real screenshot of the running console, with real passengers on it. A
    # 1600x1000 capture, placed at its own aspect ratio so nothing is squashed
    # and nothing needs cropping.
    shot = ROOT / "M1-meter-console.png"
    if shot.exists():
        s.shapes.add_picture(str(shot), Inches(6.95), Inches(2.45),
                             width=Inches(5.78), height=Inches(3.61))
        rect(s, Inches(6.95), Inches(2.45), Inches(5.78), Inches(3.61), line=RULE_HI)

    text(s, M, Inches(6.2), Inches(6.2), Inches(0.5),
         [("Rs 15 covers 2 km, then Rs 3 per km, never above Rs 25.",
           15, DIM, BODY, False)])

    footer(s, 3, "Solution")
    notes(s, "Point at the screenshot and say it is running right now, not a mockup. "
             "The fare line at the bottom is there if a judge asks for numbers.")


# ------------------------------------------------------------- 4. how it works

def how(prs):
    s = slide(prs)
    kicker(s, "How it works")
    heading(s, "Five steps.", "None need the internet.")

    steps = [
        ("01", "TAP IN", "meter notes the reading", LIVE),
        ("02", "RIDE", "kilometres count up", READ),
        ("03", "TAP OUT", "fare priced at the door", LIVE),
        ("04", "DOOR", "full bus stops boarding", CAUTION),
        ("05", "SETTLE", "money moves later", READ),
    ]

    y = Inches(3.15)
    w = Inches(2.28)
    gap = Inches(0.16)
    for i, (num, title, body, accent) in enumerate(steps):
        x = M + i * (w + gap)
        rect(s, x, y, w, Inches(2.05), fill=PANEL, line=RULE)
        rect(s, x, y, w, Inches(0.055), fill=accent)
        text(s, x + Inches(0.24), y + Inches(0.3), w - Inches(0.48), Inches(0.5),
             [(num, 30, accent, DISPLAY, True)])
        text(s, x + Inches(0.24), y + Inches(0.88), w - Inches(0.48), Inches(0.35),
             [(title, 17, READ, DISPLAY, True)])
        text(s, x + Inches(0.24), y + Inches(1.3), w - Inches(0.48), Inches(0.6),
             [(body, 12, DIM, BODY, False)])
        if i < len(steps) - 1:
            text(s, x + w, y + Inches(0.92), gap, Inches(0.3),
                 [("→", 15, RULE_HI, BODY, False)], align=PP_ALIGN.CENTER)

    text(s, M, Inches(5.8), Inches(11.9), Inches(0.6),
         [[("Steps 1 to 4 never touch a server.", 24, CAUTION, DISPLAY, True)]])

    footer(s, 4, "How it works")
    notes(s, "One breath per box, left to right. Then land the amber line slowly — it "
             "is the reason this survives where the other three rollouts died.")


# -------------------------------------------------------------- 5. innovation

def innovation(prs):
    s = slide(prs)
    kicker(s, "Why this is different")
    heading(s, "Everyone else built an app.", "We built the meter.")

    rows = [
        ("", "Card / QR ticketing", "GPS tracking", "Bhada"),
        ("Charges the real distance", "no", "no", "yes"),
        ("Works with no network", "no", "n/a", "yes"),
        ("Needs bus stops", "yes", "n/a", "no"),
        ("Stops overloading", "no", "no", "yes"),
        ("Hardware per bus", "validator + reader", "tracker", "a phone they already own"),
    ]
    top = Inches(3.2)
    row_h = Inches(0.52)
    cols = [M, M + Inches(4.4), M + Inches(7.1), M + Inches(9.5)]
    for r, row in enumerate(rows):
        y = top + r * row_h
        rect(s, M, y + row_h - Emu(9525), W - 2 * M, Emu(9525),
             fill=RULE_HI if r == 0 else RULE)
        for c, cell in enumerate(row):
            if r == 0:
                colour, size, bold = DIM, 12, False
            elif c == 0:
                colour, size, bold = READ, 15, False
            elif c == 3:
                colour, size, bold = LIVE, 15, True
            else:
                colour, size, bold = DIM, 15, False
            text(s, cols[c], y + Inches(0.09), Inches(4.2), row_h,
                 [(cell, size, colour, BODY, bold)])

    footer(s, 5, "Innovation")
    notes(s, "Run a finger down the last column. The line to say out loud is the last "
             "row: the hardware is a phone the crew already owns.")


# -------------------------------------------------------------- 6. technology

def technology(prs):
    s = slide(prs)
    kicker(s, "Technology")
    heading(s, "Already built.", "No custom hardware.", accent=LIVE)

    y = Inches(3.1)
    rect(s, M, y, Inches(7.55), Inches(2.3), fill=PANEL, line=LIVE)
    text(s, M + Inches(0.28), y + Inches(0.2), Inches(6), Inches(0.3),
         [("ON THE BUS — no internet needed", 12, LIVE, BODY, True)])

    boxes = [("Door phone A", "gets on"), ("The meter", "measures"), ("Door phone B", "gets off")]
    bw = Inches(2.28)
    for i, (title, sub) in enumerate(boxes):
        x = M + Inches(0.25) + i * (bw + Inches(0.13))
        rect(s, x, y + Inches(0.66), bw, Inches(1.0), fill=INK,
             line=PLATE if i == 1 else RULE_HI)
        text(s, x + Inches(0.18), y + Inches(0.83), bw - Inches(0.36), Inches(0.3),
             [(title, 15, READ, DISPLAY, True)])
        text(s, x + Inches(0.18), y + Inches(1.18), bw - Inches(0.36), Inches(0.3),
             [(sub, 12, DIM, BODY, False)])
        if i < 2:
            text(s, x + bw, y + Inches(1.02), Inches(0.13), Inches(0.3),
                 [("·", 15, RULE_HI, BODY, False)], align=PP_ALIGN.CENTER)

    rect(s, M, Inches(5.6), Inches(7.55), Inches(1.05), fill=PANEL, line=RULE_HI)
    text(s, M + Inches(0.28), Inches(5.76), Inches(7.0), Inches(0.75),
         [[("When a network appears", 15, READ, DISPLAY, True)],
          [("The server checks every signature and does the maths again before paying.",
            12, DIM, BODY, False)]], spacing=Pt(4))

    stack = [
        ("React PWA", "installs from a link"),
        ("ed25519", "signatures, 6 KB"),
        ("IndexedDB", "works offline"),
        ("Supabase", "Postgres + Edge Function"),
        ("32 bytes", "per second, per bus"),
        ("21 tests", "pass, headless"),
    ]
    x = Inches(8.5)
    rect(s, x, Inches(3.1), Inches(4.22), Inches(3.55), fill=PANEL, line=RULE)
    text(s, x + Inches(0.28), Inches(3.26), Inches(3.7), Inches(0.3),
         [("THE STACK", 12, DIM, BODY, True)])
    for i, (k, v) in enumerate(stack):
        yy = Inches(3.68) + i * Inches(0.46)
        text(s, x + Inches(0.28), yy, Inches(3.66), Inches(0.4),
             [[(k + "   ", 15, LIVE, DISPLAY, True), (v, 12, DIM, BODY, False)]])

    footer(s, 6, "Technology")
    notes(s, "Three devices on the bus, none of them needing a network. Then the "
             "server box: it re-checks and re-prices, so the bus is not trusted.")


# ------------------------------------------------------- 7. impact / roadmap

def impact(prs):
    s = slide(prs)
    kicker(s, "Impact and roadmap")
    heading(s, "A fare nobody argues about.", "A bus that cannot hide overloading.")

    metrics = [
        ("Rs 18", "not Rs 25", LIVE),
        ("0", "new devices", READ),
        ("42", "seats counted", READ),
        ("100%", "receipts signed", LIVE),
    ]
    w = Inches(3.05)
    for i, (value, label, colour) in enumerate(metrics):
        x = M + i * (w + Inches(0.12))
        rect(s, x, Inches(3.15), w, Inches(1.25), fill=PANEL, line=RULE)
        text(s, x + Inches(0.28), Inches(3.3), w - Inches(0.56), Inches(0.7),
             [[(value, 40, colour, DISPLAY, True)]])
        text(s, x + Inches(0.28), Inches(3.92), w - Inches(0.56), Inches(0.4),
             [(label, 13, DIM, BODY, False)])

    y = Inches(5.05)
    rect(s, M, y, W - 2 * M, Emu(19050), fill=RULE_HI)
    phases = [
        ("NOW", "Working build", LIVE),
        ("3 MONTHS", "Ten buses, one route", READ),
        ("6 MONTHS", "Real hardware, wallet", READ),
        ("12 MONTHS", "Data for operators", DIM),
    ]
    pw = (W - 2 * M) / 4
    for i, (when, what, colour) in enumerate(phases):
        x = M + int(i * pw)
        rect(s, x, y - Inches(0.09), Inches(0.1), Inches(0.2), fill=colour)
        text(s, x, y + Inches(0.25), Emu(int(pw) - 120000), Inches(0.3),
             [(when, 14, colour, DISPLAY, True)])
        text(s, x, y + Inches(0.58), Emu(int(pw) - 120000), Inches(0.4),
             [(what, 13, DIM, BODY, False)])

    text(s, M, Inches(6.3), Inches(7.5), Inches(0.4),
         [[("[Name]   ·   [Name]   ·   [Name]   ·   [Name]", 13, DIM, BODY, False)]])
    text(s, Inches(8.4), Inches(6.26), Inches(4.3), Inches(0.4),
         [[("bhada-one.vercel.app", 15, LIVE, MONO, True)]], align=PP_ALIGN.RIGHT)

    footer(s, 7, "Impact, roadmap, team")
    notes(s, "Numbers, roadmap in one sweep, names, then the invite: open the link, "
             "turn your wifi off, it still works. Hand a judge a phone if there is time.")


def main():
    prs = deck()
    cover(prs)
    problem(prs)
    solution(prs)
    how(prs)
    innovation(prs)
    technology(prs)
    impact(prs)
    prs.save(OUT)
    print(f"wrote {OUT.name} — 7 slides")


if __name__ == "__main__":
    main()
