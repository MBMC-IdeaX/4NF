"""
Builds THE PITCH: Bhada-pitch.pdf.

This is the document you hold and read from. Bhada-slides.pptx is the thing on
the wall behind you and carries almost no words on purpose — everything you
actually say is in here, written the way a person talks.

    python scripts/make-pitch.py

Rendered through headless Chrome rather than a PDF library: the page is plain
HTML and CSS, so anyone can edit the words and see the result in a browser
before printing it.

How it is laid out, and why:

  SAY      the words, verbatim, in big type — because you will be reading this
           at arm's length under stage lights with your hands shaking.
  →        a stage direction. Never read these out.
  IF LOST  a simpler way to say the same thing, for when a judge's face says
           they did not follow. Every idea in this pitch has a plain version.
  WHY      one line explaining the point to YOU. Not for the room. It is here so
           that if a judge interrupts, you can answer from understanding rather
           than from a script.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "Bhada-pitch.html"
PDF = ROOT / "Bhada-pitch.pdf"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
]


def find_chrome():
    for candidate in CHROME_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
        found = shutil.which(candidate)
        if found:
            return found
    return None


# --------------------------------------------------------------------- content

OPENER = {
    "thirty": [
        "Nepali buses have no real bus stops, so nobody knows how far you rode, "
        "so the conductor guesses your fare. A 3 kilometre ride and a 7 kilometre "
        "ride cost the same 25 rupees.",
        "We put a meter on the bus. It counts the kilometres you actually travel and "
        "charges you for those — and it finishes the payment even with no mobile "
        "network, which is what killed the three systems that came before us.",
        "The same meter counts every person who taps on, so it also knows when the "
        "bus is full, and it can hold the boarding door shut. One box, two problems.",
    ],
    "three": [
        ("Distance, not stops.",
         "The fare is measured, not guessed. And no fare gets higher than it is today."),
        ("It works with no signal.",
         "Everything up to and including taking the money happens on the bus. "
         "The internet only moves the money afterwards."),
        ("The fare machine is also the safety machine.",
         "It already counts passengers, so it can stop the bus boarding past its legal "
         "limit — for free."),
    ],
    "timing": [
        ("1", "Cover", "10 sec"),
        ("2", "Problem", "25 sec"),
        ("3", "Solution", "30 sec"),
        ("4", "How it works", "30 sec"),
        ("5", "Why different", "25 sec"),
        ("6", "Technology", "30 sec"),
        ("7", "Impact + team", "30 sec"),
    ],
}

SLIDES = [
    {
        "n": 1,
        "time": "10 sec",
        "title": "Cover",
        "screen": "BHADA · Bus fare by the kilometre. Works with no signal.",
        "say": [
            "This is Bhada.",
            "It charges bus fare by the kilometre you actually travel — and it works "
            "even when there is no mobile network.",
        ],
        "do": [
            "Say it, then stop. Do not start explaining. Click.",
            "If you only get one sentence out today, this is the one.",
        ],
        "lost": None,
        "why": "Ten seconds buys you one idea. Spend it on the promise, not the problem.",
    },
    {
        "n": 2,
        "time": "25 sec",
        "title": "Problem",
        "screen": "Nepali buses have no bus stops. · 2.9 km = Rs 25 · 7.5 km = Rs 25",
        "say": [
            "In Nepal, buses do not really have bus stops.",
            "You wave the bus down wherever you are standing. You get off wherever the "
            "traffic stops.",
            "So nobody actually knows how far you went. The conductor guesses.",
            "And the price list is written stop to stop — so his guess is what decides "
            "what you pay.",
            "Look at these two. A 2.9 kilometre ride costs 25 rupees. The full 7.5 "
            "kilometre ride also costs 25 rupees.",
            "Same bus. Same money. Less than half the distance.",
            "And this has been tried before. Three digital ticketing systems in Nepal — "
            "Sajha, Bharatpur, about 800 buses in Pokhara. All three were dropped. Every "
            "time for the same reason: the network died in the middle of the payment.",
        ],
        "do": [
            "Point at the two cards as you read the numbers.",
            "Slow down on “same bus, same money”. That is the sentence they repeat later.",
            "Do not rush the last line. It is the reason this is hard, not the reason "
            "it is impossible.",
        ],
        "lost": "Think of a taxi that charges you by which area you said you were going "
                "to, instead of by what the meter says. That is a Nepali bus fare today.",
        "why": "Two failures in one slide: the fare is unfair, and the obvious fix has "
               "already failed three times. If you skip the second, a judge will raise "
               "it as an objection instead of hearing it as your insight.",
    },
    {
        "n": 3,
        "time": "30 sec",
        "title": "Solution",
        "screen": "One box under the seat. It measures the ride.",
        "say": [
            "So we put one small box on the bus.",
            "It watches the GPS and counts how far the bus actually goes. Like a taxi "
            "meter, but for the whole bus.",
            "You tap when you get on. You tap when you get off. It charges you for the "
            "kilometres in between.",
            "Fifteen rupees covers your first two kilometres. After that it is three "
            "rupees a kilometre. And it never goes above 25 — which is exactly what the "
            "whole route costs today.",
            "So the cheapest fare stays the same, the most expensive fare stays the same, "
            "and everything in the middle gets cheaper. Nobody pays more than they pay "
            "now. That is the part you can take to a regulator.",
            "And here is the piece people miss. The box is already counting every person "
            "who taps on. So it also knows when the bus is full — and it can hold the "
            "boarding door shut.",
        ],
        "do": [
            "Point at the screen: “this is running right now, it is not a mockup.”",
            "Pause half a second before the door line. It is the surprise.",
        ],
        "lost": "Rs 15 to get on, which covers 2 km. Rs 3 for every kilometre after "
                "that. Never more than Rs 25, no matter how far you go.",
        "why": "The floor is today's minimum fare and the ceiling is today's maximum, so "
               "the whole change happens inside a price range people already accept. That "
               "is why this is a fare proposal a regulator can say yes to.",
    },
    {
        "n": 4,
        "time": "30 sec",
        "title": "How it works",
        "screen": "Five steps. None need the internet.",
        "say": [
            "One. You tap. The meter writes down its current reading.",
            "Two. The bus drives. The kilometres count up.",
            "Three. You tap again at the other door. It subtracts the two readings and "
            "tells you the price.",
            "Four. Every tap is also a head count. When the bus reaches its legal limit, "
            "the boarding door will not open.",
            "Five. Later, whenever the bus finds signal, the money moves.",
            "Now the important part. Steps one to four never touch a server.",
            "That is the whole reason this works in Nepal. The other three systems needed "
            "the network at the exact second the passenger was standing in the door, with "
            "ten people behind them. Ours does not. Nothing waits for a signal.",
        ],
        "do": [
            "One breath per box, left to right, touching each one.",
            "Then turn away from the screen and say the last two lines to the room.",
        ],
        "lost": "It is like a paper ticket. You get one when you get on, you hand it "
                "back when you get off. The difference is that ours has a stamp on it "
                "that nobody can copy, and it remembers the odometer reading.",
        "why": "The passenger's ticket physically carries the boarding reading, so the "
               "back door can price the ride without ever talking to the front door. "
               "That is the trick that removes the network from the critical path.",
    },
    {
        "n": 5,
        "time": "25 sec",
        "title": "Why this is different",
        "screen": "Everyone else built an app. We built the meter.",
        "say": [
            "Card and QR ticketing charges you by stop. So it needs stops we do not have, "
            "and it needs a network.",
            "GPS trackers know where the bus is, but they do not charge anybody and they "
            "do not count passengers.",
            "We do both. Offline. On a phone the conductor already owns — nothing to buy, "
            "nothing to bolt onto the bus, no card for the passenger to lose.",
            "And the fare is not decided by the bus. When the ride reaches our server, "
            "the server does the same maths over again on its own. If the bus reported a "
            "number that does not match, the fare is refused.",
            "So we do not have to trust the operator, and the passenger does not have to "
            "trust us.",
        ],
        "do": [
            "Run a finger down the last column of the table while you talk.",
            "“A phone the conductor already owns” is the line that turns this from a "
            "pilot into something an operator can afford. Say it clearly.",
        ],
        "lost": "Other systems are a payment app. Ours is a measuring instrument that "
                "happens to take payment.",
        "why": "Every previous attempt started from the payment. We started from the "
               "measurement, and the payment fell out of it. That is the actual novelty.",
    },
    {
        "n": 6,
        "time": "30 sec",
        "title": "Technology",
        "screen": "Already built. No custom hardware.",
        "say": [
            "There are three things on the bus. A phone at the front door, a phone at the "
            "back door, and the meter in the middle.",
            "They talk to each other over the bus itself, not over the internet — so they "
            "keep working in a tunnel.",
            "And if they cannot even talk to each other: when you tap on, the meter hands "
            "you a signed ticket. The back door can read that ticket on its own and price "
            "the ride from it. Nothing is lost.",
            "When signal comes back, everything goes up to the server. It checks every "
            "signature and does the pricing again itself before any money moves.",
            "This is all built and it is all running. Twenty-one automated tests pass with "
            "no bus and no phone involved — you can run them on a laptop in ten seconds.",
        ],
        "do": [
            "Left box first, then the server box underneath it.",
            "If a judge is technical, the last line is an invitation. Let them take it.",
        ],
        "lost": "Two phones and a meter, talking to each other inside the bus. The "
                "internet is only used at the end, to move the money.",
        "why": "Signed means the ticket was stamped with a key only that bus holds, and "
               "the server can check the stamp. That is how a piece of paper travelling "
               "on a passenger becomes evidence rather than a claim.",
    },
    {
        "n": 7,
        "time": "30 sec",
        "title": "Impact, roadmap, team",
        "screen": "Rs 18 not Rs 25 · 0 new devices · 42 seats counted · 100% signed",
        "say": [
            "So what actually changes.",
            "That 2.9 kilometre ride becomes 18 rupees instead of 25. And nobody pays "
            "more than they do today.",
            "Every seat is counted, and every ride leaves a signed receipt. So two things "
            "that are invisible today — overloading, and cash that does not come back — "
            "both become visible.",
            "And it needs no new devices. The phones are already in their pockets.",
            "Next three months: ten buses on one route, with a real operator. Then proper "
            "hardware and a wallet like eSewa or Khalti. After that, selling route data "
            "back to operators — because right now nobody in Nepal knows what a route "
            "earns per kilometre.",
            "It is live at this link right now. Open it, turn your wifi off, and it still "
            "works.",
            "Thank you.",
        ],
        "do": [
            "Names out loud, one second each. Look at each person as you say theirs.",
            "If there is any time left, hand a judge a phone and let them tap it.",
        ],
        "lost": None,
        "why": "Close on something they can do, not something they have to believe. The "
               "wifi line is the strongest thing in the whole pitch — it is a claim they "
               "can falsify in five seconds and it will hold.",
    },
]

QA = [
    ("“The operator loses money.”",
     "In the middle of the curve, yes — and that is the point. Three things push back. "
     "Every fare is recorded now, so cash that goes missing today stops being invisible. "
     "Short trips people currently walk become worth taking. And for the first time an "
     "operator can see what a route earns per passenger-kilometre. We will not quote you "
     "a percentage, because we have not measured it on a real route yet."),
    ("“Who decides the price?”",
     "Not us. It is a published tariff — a row in a database, with a date on it, that "
     "anyone can read. We built the meter; the regulator sets the numbers. We chose "
     "numbers that cannot raise any fare on this route, because that is the only honest "
     "place to start the conversation."),
    ("“What if somebody does not tap out?”",
     "They are charged the maximum, 25 rupees. It has to work that way — if not tapping "
     "out were cheaper, nobody would ever tap out. Every metro system in the world does "
     "the same thing."),
    ("“What if the bus lies about the distance?”",
     "The server prices the ride again from the recorded distance and refuses anything "
     "that does not match. Someone could still feed the box fake GPS — that is true of "
     "every taximeter in the world. We keep the whole trace, so a route whose distances "
     "stop matching its actual shape shows up in the data."),
    ("“Is it legal to lock a bus door?”",
     "Only the boarding door, and only while the bus is stopped. The exit door is never "
     "held shut — that rule is written into the core code, not the interface, so it "
     "cannot be removed by accident. And a crew override always opens everything and "
     "writes a record of who did it and when."),
    ("“What if the passenger has no smartphone?”",
     "Then they do not need one. The conductor taps for them at the door, and the ticket "
     "can be shown on the terminal's own screen. A passenger with no phone is the normal "
     "case we designed for, not the exception."),
    ("“What about people who pay cash?”",
     "Cash still works exactly as it does today. This does not replace the conductor, it "
     "gives him a meter. A bus can run half metered and half cash on day one."),
    ("“Has it run on a real bus?”",
     "No. That is the honest answer. It is proven against a scripted drive with real GPS "
     "noise, and it behaves correctly under every failure we wrote it for — a parked bus "
     "bills nothing, a GPS jump is thrown away, a tampered receipt is rejected. Real "
     "Kathmandu traffic is the next test, and it is the first thing on the roadmap."),
    ("“How do you make money?”",
     "Not from the fare. Per bus, per month, for the meter — and later from route data, "
     "which no operator or regulator in Nepal has ever had."),
    ("“Why will this not die like the other three?”",
     "Because those three needed a network at the moment of payment and we do not. That "
     "is not a feature we added; it is the constraint the whole thing was designed "
     "around, and everything else in the design follows from it."),
]

NUMBERS = [
    ("Rs 15", "gets you on, and covers the first 2 km"),
    ("Rs 3", "per kilometre after that"),
    ("Rs 25", "the most anyone can pay — today's full-route fare"),
    ("Rs 18", "what a 2.9 km ride costs now, instead of Rs 25"),
    ("Half price", "students and seniors, automatically"),
    ("42", "passengers on this bus's permit — 30 seated, 12 standing"),
    ("3", "systems tried before, all abandoned"),
    ("21", "automated tests passing"),
    ("0", "new devices an operator has to buy"),
]

DEMO = [
    "Laptop on the projector: open /device. That is the meter.",
    "Press “Pair a door terminal”. Scan the code with both phones. Twenty seconds.",
    "On phone A press “+ Enrol a passenger”, type a name. That is the whole sign-up.",
    "Judge holds phone A and taps. Walk ten metres. Tap phone B. The fare appears.",
    "Turn the wifi off before the second tap. Nothing changes. That is the demo.",
    "Set the capacity to 3 and enrol a fourth person: the door goes red and the tap "
    "is refused.",
    "If the room has no GPS, press “Run bench drive” on the laptop first — it feeds "
    "the meter a scripted route through exactly the same filter as a real receiver.",
]

CSS = """
@page { size: A4; margin: 15mm 15mm 13mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font: 10.5pt/1.5 "Segoe UI", system-ui, sans-serif; color: #16130f; background: #fff; }

.mast { border-bottom: 2.5pt solid #a8202f; padding-bottom: 9pt; margin-bottom: 13pt; }
.mast h1 { font: 700 25pt/1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif; }
.mast p { color: #6d675c; font-size: 10pt; margin-top: 4pt; }

.opener { background: #f4f2ec; border-left: 3pt solid #16130f; padding: 11pt 13pt; margin-bottom: 13pt; }
.opener h3 { font: 700 12pt/1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif;
             text-transform: uppercase; letter-spacing: .06em; color: #6d675c; margin-bottom: 7pt; }
.opener p { font-size: 11.5pt; line-height: 1.45; margin-bottom: 6pt; }
.opener p:last-child { margin-bottom: 0; }

.three { display: table; width: 100%; border-collapse: collapse; margin-bottom: 13pt; }
.three > div { display: table-row; }
.three b, .three span { display: table-cell; padding: 5pt 8pt 5pt 0; border-bottom: 1px solid #d8d3c7;
                        vertical-align: top; }
.three b { width: 38%; font-size: 11pt; }
.three span { font-size: 10pt; color: #3c372f; }

.timing { width: 100%; border-collapse: collapse; margin-bottom: 4pt; font-size: 9.5pt; }
.timing td { padding: 3pt 6pt 3pt 0; border-bottom: 1px solid #e6e2d9; color: #6d675c; }
.timing td:first-child { color: #a8202f; font-weight: 700; width: 18pt; }
.timing td:nth-child(2) { color: #16130f; }
.timing td:last-child { text-align: right; font-variant-numeric: tabular-nums; }

.slide { break-inside: avoid; margin-bottom: 14pt; padding-bottom: 11pt; border-bottom: 1px solid #d8d3c7; }
.head { display: flex; align-items: baseline; gap: 9pt; margin-bottom: 3pt; }
.num { font: 700 12pt/1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif;
       background: #a8202f; color: #fff; padding: 3pt 8pt; }
.title { font: 700 16pt/1.1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif; }
.time { margin-left: auto; font-size: 9.5pt; color: #6d675c; font-variant-numeric: tabular-nums; }
.screen { font-size: 9pt; color: #6d675c; margin-bottom: 8pt; }
.screen b { color: #16130f; font-weight: 600; }

.say { border-left: 3pt solid #16130f; padding-left: 11pt; margin-bottom: 8pt; }
.say p { font-size: 12.5pt; line-height: 1.45; margin-bottom: 5pt; }
.say p:last-child { margin-bottom: 0; }

.do { font-size: 9.5pt; color: #6d675c; padding-left: 13pt; margin-bottom: 6pt; }
.do li { margin-bottom: 2pt; list-style: none; text-indent: -9pt; }
.do li::before { content: "→ "; color: #a8202f; }

.aside { font-size: 9.5pt; padding: 6pt 9pt; margin-bottom: 5pt; }
.lost { background: #f4f2ec; border-left: 2pt solid #a8202f; }
.why { color: #6d675c; border-left: 2pt solid #d8d3c7; }
.aside b { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .07em; color: #a8202f; }
.why b { color: #6d675c; }

h2 { font: 700 16pt/1.1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif;
     margin: 6pt 0 10pt; padding-top: 11pt; border-top: 2.5pt solid #a8202f; break-after: avoid; }

.qa { break-inside: avoid; margin-bottom: 9pt; }
.qa .q { font-weight: 600; font-size: 10.5pt; }
.qa .a { font-size: 10pt; color: #3c372f; }

.nums { width: 100%; border-collapse: collapse; font-size: 10pt; margin-bottom: 4pt; }
.nums td { padding: 4pt 8pt 4pt 0; border-bottom: 1px solid #e6e2d9; }
.nums td:first-child { font: 700 13pt/1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif;
                       width: 74pt; color: #a8202f; }
.nums td:last-child { color: #3c372f; }

.runbook { font-size: 10pt; padding-left: 15pt; }
.runbook li { margin-bottom: 4pt; }
"""


def html():
    p = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        "<title>Bhada — the pitch</title>",
        f"<style>{CSS}</style></head><body>",
        "<div class='mast'><h1>Bhada — the pitch</h1>",
        "<p>Seven slides, three minutes. Read the big black text out loud. "
        "Everything in grey is for you, not for the room.</p></div>",
    ]

    p.append("<div class='opener'><h3>If you only get 30 seconds</h3>")
    for line in OPENER["thirty"]:
        p.append(f"<p>{line}</p>")
    p.append("</div>")

    p.append("<h2>Three things to land</h2><div class='three'>")
    for title, body in OPENER["three"]:
        p.append(f"<div><b>{title}</b><span>{body}</span></div>")
    p.append("</div>")

    p.append("<table class='timing'>")
    for n, name, t in OPENER["timing"]:
        p.append(f"<tr><td>{n}</td><td>{name}</td><td>{t}</td></tr>")
    p.append("</table>")

    p.append("<h2>The pitch, word for word</h2>")
    for s in SLIDES:
        p.append("<div class='slide'>")
        p.append(f"<div class='head'><span class='num'>{s['n']}</span>"
                 f"<span class='title'>{s['title']}</span>"
                 f"<span class='time'>{s['time']}</span></div>")
        p.append(f"<p class='screen'><b>On screen:</b> {s['screen']}</p>")
        p.append("<div class='say'>")
        for line in s["say"]:
            p.append(f"<p>{line}</p>")
        p.append("</div><ul class='do'>")
        for line in s["do"]:
            p.append(f"<li>{line}</li>")
        p.append("</ul>")
        if s["lost"]:
            p.append(f"<div class='aside lost'><b>If they look lost</b><br>{s['lost']}</div>")
        p.append(f"<div class='aside why'><b>Why this slide exists</b><br>{s['why']}</div>")
        p.append("</div>")

    p.append("<h2>If they ask</h2>")
    for q, a in QA:
        p.append(f"<div class='qa'><div class='q'>{q}</div><div class='a'>{a}</div></div>")

    p.append("<h2>Numbers to know cold</h2><table class='nums'>")
    for value, meaning in NUMBERS:
        p.append(f"<tr><td>{value}</td><td>{meaning}</td></tr>")
    p.append("</table>")

    p.append("<h2>If they want to see it</h2><ol class='runbook'>")
    for step in DEMO:
        p.append(f"<li>{step}</li>")
    p.append("</ol>")

    p.append("</body></html>")
    return "\n".join(p)


def main():
    HTML.write_text(html(), encoding="utf-8")
    chrome = find_chrome()
    if not chrome:
        print(f"wrote {HTML.name}. No Chrome found — open it and print to PDF by hand.")
        return 0

    subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
         f"--print-to-pdf={PDF}", HTML.as_uri()],
        check=True, capture_output=True,
    )
    print(f"wrote {PDF.name} (from {HTML.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
