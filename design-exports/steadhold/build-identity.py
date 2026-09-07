#!/usr/bin/env python3
"""Steadhold identity — generates the showcase and every production asset.

The mark is authored once, on the 200 grid, in MARK below. Everything else
(1024-grid masters, favicon, PWA icons, the showcase) is derived from it, so
there is exactly one place to change the geometry.
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "logo")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# ── palette ───────────────────────────────────────────────────────────────────
INK          = "#171310"   # near-black, warmed toward the accent's hue
INK_FIELD    = "#12100E"   # dark surfaces
PAPER        = "#FAF6F0"   # off-white, warm
PAPER_GLYPH  = "#F2EAE0"   # the glyph on dark
ACCENT       = "#B4502E"   # terracotta — earth, fired clay
ACCENT_DEEP  = "#8E3D22"
ACCENT_BRIGHT= "#E07A52"
MUTED, FAINT, HAIRLINE = "#8A7A6B", "#C9BBAA", "#E7DFD4"

# ── the mark ──────────────────────────────────────────────────────────────────
# A chiselled S: two opposing bowls with the Bézier controls pulled to the
# corners (so the curves read cut, not drawn) and butt caps landing on vertical
# tangents, which gives both terminals a flat stone cut. The ground line at
# y=126 falls exactly where the two bowls lock, so the accent is the whole
# lower bowl — one complete stratum, never a sliver.
SPINE = ("M146 60 C146 38 126 28 100 28 C72 28 52 44 52 66 "
         "C52 84 66 94 90 100 C114 106 148 114 148 134 "
         "C148 156 126 172 100 172 C72 172 54 160 54 138")
STROKE, CUT = 28, 126

def mark(top, bottom, uid="m", scale=1.0):
    """The mark's inner SVG, on the 200 grid. `scale` shrinks about the centre."""
    g = f'<g transform="translate(100 100) scale({scale}) translate(-100 -100)">' if scale != 1.0 else '<g>'
    return (
        f'<clipPath id="up-{uid}"><rect x="0" y="0" width="200" height="{CUT}"/></clipPath>'
        f'<clipPath id="dn-{uid}"><rect x="0" y="{CUT}" width="200" height="{200 - CUT}"/></clipPath>'
        + g
        + f'<path d="{SPINE}" fill="none" stroke="{top}" stroke-width="{STROKE}"'
          f' stroke-linecap="butt" clip-path="url(#up-{uid})"/>'
        + f'<path d="{SPINE}" fill="none" stroke="{bottom}" stroke-width="{STROKE}"'
          f' stroke-linecap="butt" clip-path="url(#dn-{uid})"/>'
        + '</g>')

def svg200(top, bottom, uid="m", scale=1.0, size=None):
    a = f' width="{size}" height="{size}"' if size else ''
    return (f'<svg viewBox="0 0 200 200"{a} xmlns="http://www.w3.org/2000/svg">'
            f'{mark(top, bottom, uid, scale)}</svg>')

def svg1024(top, bottom, uid="m", scale=1.0, field=None, rx=None, title=""):
    """Production master: the 1024 grid, coordinates kept as authored."""
    bg = ''
    if field:
        r = f' rx="{rx}"' if rx else ''
        bg = f'<rect x="0" y="0" width="1024" height="1024"{r} fill="{field}"/>'
    t = f'<title>{title}</title>' if title else ''
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" '
            'width="1024" height="1024">'
            f'{t}{bg}<g transform="scale(5.12)">{mark(top, bottom, uid, scale)}</g></svg>')

# ── production assets ─────────────────────────────────────────────────────────
ASSETS = {
    # free-standing masters (transparent)
    "logo-paper.svg":  svg1024(INK, ACCENT, "lp", title="Steadhold — mark, light surfaces"),
    "logo-reader.svg": svg1024(PAPER_GLYPH, ACCENT_BRIGHT, "lr", title="Steadhold — mark, dark surfaces"),
    # favicon carries a field: a free-standing ink glyph disappears on a dark tab
    "favicon.svg":     svg1024(PAPER_GLYPH, ACCENT_BRIGHT, "fv", scale=0.92,
                               field=INK_FIELD, rx=220, title="Steadhold"),
    # maskable: glyph pulled inside the 0.4·1024 safe radius
    "icon-maskable.svg": svg1024(PAPER_GLYPH, ACCENT_BRIGHT, "mk", scale=0.82,
                                 field=INK_FIELD, title="Steadhold"),
}
RASTERS = [  # (source svg, px, out png, opaque background or None)
    ("favicon.svg", 16, "favicon-16.png", None),
    ("favicon.svg", 32, "favicon-32.png", None),
    ("favicon.svg", 48, "favicon-48.png", None),
    ("icon-maskable.svg", 192, "icon-192.png", None),
    ("icon-maskable.svg", 512, "icon-512.png", None),
    ("icon-maskable.svg", 180, "apple-touch-icon.png", INK_FIELD),  # iOS: no alpha
]

def shoot(html_path, out_png, w, h, transparent=True, scale=1):
    cmd = [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
           f"--force-device-scale-factor={scale}",
           f"--screenshot={out_png}", f"--window-size={w},{h}"]
    if transparent:
        cmd.append("--default-background-color=00000000")
    cmd.append("file://" + html_path)
    subprocess.run(cmd, capture_output=True)

def build_assets():
    os.makedirs(LOGO, exist_ok=True)
    for name, body in ASSETS.items():
        open(os.path.join(LOGO, name), "w").write(body + "\n")
    for src, px, out, bg in RASTERS:
        # An <img> of the SVG at an exact pixel box, screenshotted with a
        # transparent backdrop: the only rasteriser available here.
        fill = f"background:{bg};" if bg else ""
        tmp = "/tmp/_sh_raster.html"
        open(tmp, "w").write(
            f'<!doctype html><meta charset="utf-8"><style>html,body{{margin:0;padding:0}}'
            f'img{{display:block;width:{px}px;height:{px}px;{fill}}}</style>'
            f'<img src="file://{os.path.join(LOGO, src)}">')
        shoot(tmp, os.path.join(LOGO, out), px, px, transparent=not bg)
    # .ico from the three favicon sizes
    try:
        from PIL import Image
        imgs = [Image.open(os.path.join(LOGO, f"favicon-{s}.png")).convert("RGBA")
                for s in (16, 32, 48)]
        imgs[2].save(os.path.join(LOGO, "favicon.ico"),
                     sizes=[(16, 16), (32, 32), (48, 48)])
    except Exception as e:                                   # noqa: BLE001
        print(f"  ! favicon.ico skipped: {e}", file=sys.stderr)
    print(f"  assets → {LOGO}")

# ── the showcase ──────────────────────────────────────────────────────────────
def principle(idx, title, body):
    return (f'<div class="principle"><div class="idx">{idx}</div>'
            f'<h3>{title}</h3><p>{body}</p></div>')

def variation(uid, top, bottom, scale, meaning, name, body, dark=False):
    tile = "dark" if dark else ""
    return (f'<div class="var {tile}"><div class="holder">'
            f'{svg200(top, bottom, uid, scale, size=96)}</div>'
            f'<div class="mng">{meaning}</div><h4>{name}</h4><p>{body}</p></div>')

def build_showcase():
    light = svg200(INK, ACCENT, "pl", size=250)
    dark  = svg200(PAPER_GLYPH, ACCENT_BRIGHT, "pd", size=250)
    swatches = [("Ink", INK, "Text, glyph, dark fields. A near-black warmed toward the clay."),
                ("Paper", PAPER, "Every light surface. Never flat #FFF."),
                ("Terracotta", ACCENT, "The accent. Fired earth — the ground you hold."),
                ("Terracotta deep", ACCENT_DEEP, "Borders and text on light."),
                ("Terracotta bright", ACCENT_BRIGHT, "The glyph and links on dark."),
                ("Hairline", HAIRLINE, "Rules and dividers, derived from the ink.")]
    sw = ''.join(
        f'<div class="sw"><div class="chip" style="background:{hexv}"></div>'
        f'<div class="sw-b"><b>{n}</b><code>{hexv}</code><p>{d}</p></div></div>'
        for n, hexv, d in swatches)

    legibility = ''.join(
        f'<div class="lg"><div class="lg-box">{svg200(INK, ACCENT, f"lg{px}", size=px)}</div>'
        f'<span>{px}px</span></div>' for px in (128, 64, 32, 24, 20, 16))
    legibility_dark = ''.join(
        f'<div class="lg dk"><div class="lg-box">'
        f'{svg200(PAPER_GLYPH, ACCENT_BRIGHT, f"lgd{px}", size=px)}</div>'
        f'<span>{px}px</span></div>' for px in (128, 64, 32, 24, 20, 16))

    html = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Steadhold · Identity System</title>
<link rel="icon" href="logo/favicon.svg"/>
<link href="https://fonts.googleapis.com/css2?family=Zilla+Slab:ital,wght@0,400;0,600;0,700;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
 :root{{
  --paper:{PAPER}; --paper-deep:#F2EAE0; --card:#FFFDFA;
  --ink:{INK}; --ink-field:{INK_FIELD}; --ink-muted:{MUTED}; --ink-faint:{FAINT};
  --accent:{ACCENT}; --accent-deep:{ACCENT_DEEP}; --accent-bright:{ACCENT_BRIGHT};
  --accent-soft:{ACCENT}14; --hairline:{HAIRLINE};
  --serif:"Zilla Slab",Georgia,serif;
  --sans:"Space Grotesk",-apple-system,BlinkMacSystemFont,sans-serif;
 }}
 *{{box-sizing:border-box;margin:0;padding:0}}
 html,body{{background:var(--paper);color:var(--ink);font-family:var(--sans);
   -webkit-font-smoothing:antialiased}}
 ::selection{{background:var(--accent);color:#fff}}
 .wrap{{max-width:1080px;margin:0 auto;padding:72px 28px 110px}}
 header{{margin-bottom:60px}}
 .kicker{{display:inline-flex;align-items:center;gap:10px;font-size:11.5px;
   letter-spacing:.34em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:22px}}
 .kicker .sq{{width:9px;height:9px;border-radius:2px;background:var(--accent);
   transform:rotate(-15deg)}}
 h1{{font-family:var(--serif);font-weight:700;font-size:clamp(44px,8vw,82px);
   line-height:.98;letter-spacing:-.02em}}
 h1 em{{font-style:italic;font-weight:400;color:var(--accent)}}
 .lede{{margin-top:24px;max-width:620px;color:var(--ink-muted);font-size:16px;line-height:1.65}}
 .lede b{{color:var(--ink);font-weight:600}}
 section{{margin-top:80px}}
 .sec-label{{display:flex;align-items:baseline;gap:14px;margin-bottom:28px;
   border-top:1px solid var(--hairline);padding-top:18px}}
 .sec-label .no{{font-family:var(--serif);font-style:italic;font-size:20px;color:var(--accent)}}
 .sec-label h2{{font-family:var(--serif);font-weight:600;font-size:29px;letter-spacing:-.015em}}
 .sec-label .note{{margin-left:auto;font-size:12.5px;color:var(--ink-faint);
   max-width:320px;text-align:right;line-height:1.5}}
 .principles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
   gap:1px;background:var(--hairline);border:1px solid var(--hairline);
   border-radius:14px;overflow:hidden}}
 .principle{{background:var(--card);padding:26px 24px 28px}}
 .principle .idx{{font-size:11px;letter-spacing:.2em;color:var(--accent);margin-bottom:14px}}
 .principle h3{{font-family:var(--serif);font-size:21px;font-weight:600;margin-bottom:10px;
   line-height:1.15}}
 .principle p{{font-size:13.5px;line-height:1.6;color:var(--ink-muted)}}
 .marks{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
 .mark-tile{{border-radius:18px;padding:52px;display:flex;flex-direction:column;
   align-items:center;gap:26px;border:1px solid var(--hairline)}}
 .mark-tile.light{{background:var(--card)}}
 .mark-tile.dark{{background:var(--ink-field);border-color:#ffffff14}}
 .mark-tile .caption{{font-size:11.5px;letter-spacing:.18em;text-transform:uppercase}}
 .mark-tile.light .caption{{color:var(--ink-muted)}}
 .mark-tile.dark .caption{{color:#A99384}}
 .construct{{display:grid;grid-template-columns:1fr .85fr;gap:34px;align-items:center;
   background:var(--card);border:1px solid var(--hairline);border-radius:16px;padding:34px}}
 .construct h3{{font-family:var(--serif);font-size:24px;font-weight:600;margin-bottom:16px}}
 .construct ul{{list-style:none;display:flex;flex-direction:column;gap:13px}}
 .construct li{{display:flex;gap:12px;font-size:14px;color:var(--ink-muted);line-height:1.5}}
 .construct li b{{color:var(--ink)}}
 .construct code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
   background:var(--accent-soft);color:var(--accent-deep);padding:1px 6px;border-radius:4px}}
 .construct .dot{{flex:0 0 auto;width:7px;height:7px;border-radius:2px;
   background:var(--accent);transform:rotate(-15deg);margin-top:6px}}
 .draw{{display:flex;justify-content:center}}
 .grid-fig{{background:
   repeating-linear-gradient(0deg,var(--hairline) 0 1px,transparent 1px 25px),
   repeating-linear-gradient(90deg,var(--hairline) 0 1px,transparent 1px 25px);
   border:1px solid var(--hairline);border-radius:10px}}
 .vars{{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}}
 .var{{background:var(--card);border:1px solid var(--hairline);border-radius:14px;
   padding:28px 22px 24px;text-align:center}}
 .var.dark{{background:var(--ink-field);border-color:#ffffff14;color:var(--paper-deep)}}
 .var .holder{{height:112px;display:flex;align-items:center;justify-content:center;
   margin-bottom:16px}}
 .var .mng{{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;
   color:var(--accent);margin-bottom:8px}}
 .var.dark .mng{{color:var(--accent-bright)}}
 .var h4{{font-family:var(--serif);font-size:19px;font-weight:600;margin-bottom:8px}}
 .var p{{font-size:12.5px;line-height:1.55;color:var(--ink-muted)}}
 .var.dark p{{color:#A99384}}
 .lockups{{display:flex;flex-direction:column;gap:18px}}
 .lock{{display:flex;align-items:center;gap:18px;background:var(--card);
   border:1px solid var(--hairline);border-radius:14px;padding:30px 34px}}
 .lock.dark{{background:var(--ink-field);border-color:#ffffff14}}
 .lock .name{{font-family:var(--serif);font-weight:700;font-size:44px;letter-spacing:-.025em}}
 .lock.dark .name{{color:var(--paper-deep)}}
 .lock.sm .name{{font-size:23px}}
 .lock .tail{{margin-left:auto;font-size:11px;letter-spacing:.2em;text-transform:uppercase;
   color:var(--ink-faint)}}
 .lock .rule{{width:1px;align-self:stretch;background:var(--hairline)}}
 .lock.dark .rule{{background:#ffffff1f}}
 .lock .tag{{font-size:12.5px;color:var(--ink-muted);max-width:210px;line-height:1.5}}
 .legibility{{display:flex;flex-direction:column;gap:16px}}
 .lgrow{{display:flex;gap:26px;align-items:flex-end;background:var(--card);
   border:1px solid var(--hairline);border-radius:14px;padding:28px 32px;flex-wrap:wrap}}
 .lgrow.dark{{background:var(--ink-field);border-color:#ffffff14}}
 .lg{{display:flex;flex-direction:column;align-items:center;gap:10px}}
 .lg-box{{display:flex;align-items:flex-end;height:128px}}
 .lg span{{font-size:10.5px;letter-spacing:.14em;color:var(--ink-faint)}}
 .lg.dk span{{color:#8B7768}}
 .vars-pal{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}
 .sw{{background:var(--card);border:1px solid var(--hairline);border-radius:14px;
   overflow:hidden}}
 .sw .chip{{height:82px}}
 .sw-b{{padding:16px 18px 20px}}
 .sw-b b{{display:block;font-family:var(--serif);font-size:17px;font-weight:600}}
 .sw-b code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
   color:var(--ink-muted);letter-spacing:.04em}}
 .sw-b p{{margin-top:9px;font-size:12.5px;line-height:1.5;color:var(--ink-muted)}}
 .type{{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}}
 .tcard{{background:var(--card);border:1px solid var(--hairline);border-radius:14px;padding:28px}}
 .tcard .lbl{{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;
   color:var(--accent);margin-bottom:14px}}
 .tcard .spec{{font-size:12.5px;color:var(--ink-muted);margin-top:12px;line-height:1.55}}
 .tsample-serif{{font-family:var(--serif);font-size:34px;font-weight:600;letter-spacing:-.02em}}
 .tsample-sans{{font-family:var(--sans);font-size:26px;font-weight:500}}
 footer{{margin-top:84px;border-top:1px solid var(--hairline);padding-top:24px;
   font-size:12px;color:var(--ink-faint);display:flex;gap:18px;flex-wrap:wrap}}
 @media (max-width:820px){{.marks,.vars,.vars-pal,.construct,.type{{grid-template-columns:1fr}}}}
</style></head><body><div class="wrap">

<header>
  <div class="kicker"><span class="sq"></span> Steadhold · identity system</div>
  <h1>The ground<br/>you <em>hold</em>.</h1>
  <p class="lede">Steadhold is a self-hostable, Postgres-first backend. Every project is
  a <b>real Postgres container with a real DATABASE_URL</b>, and one command exports a
  tarball that restores into vanilla Postgres and MinIO with no vendor runtime.
  The mark has one job: say <b>founded, not rented</b>.</p>
</header>

<!-- 01 PHILOSOPHY -->
<section>
  <div class="sec-label"><span class="no">01</span><h2>Philosophy</h2>
    <span class="note">One idea, carried by one letter, in one accent.</span></div>
  <div class="principles">
    {principle("i", "Founded, not floating",
      "No clouds, no cylinders, no shields. The glyph is cut and it sits on ground — "
      "the accent is the stratum it stands in.")}
    {principle("ii", "Chiselled, not drawn",
      "The bowls&rsquo; controls are pulled to the corners so the curves read cut rather "
      "than sketched, and both terminals land on a flat stone edge.")}
    {principle("iii", "Two colours, one accent",
      "Ink, paper, and a single terracotta. The accent marks the one thing that matters "
      "and is never spent on decoration.")}
    {principle("iv", "Anti-magic",
      "Nothing here is a gradient, a bevel or a glow. The same discipline as the code: "
      "hand-written, legible, no hidden machinery.")}
  </div>
</section>

<!-- 02 PRIMARY MARK -->
<section>
  <div class="sec-label"><span class="no">02</span><h2>The mark</h2>
    <span class="note">Free-standing. The bezel appears only on the favicon, where a tab
    can be any colour.</span></div>
  <div class="marks">
    <div class="mark-tile light">{light}<span class="caption">Ink on paper</span></div>
    <div class="mark-tile dark">{dark}<span class="caption">Paper on ink</span></div>
  </div>
</section>

<!-- 03 CONSTRUCTION -->
<section>
  <div class="sec-label"><span class="no">03</span><h2>Construction</h2>
    <span class="note">Two paths, one clip. Authored on the 200 grid, shipped on 1024.</span></div>
  <div class="construct">
    <div class="specs">
      <h3>One spine, cut at the waist</h3>
      <ul>
        <li><span class="dot"></span><span><b>Grid</b> — <code>viewBox 0 0 200 200</code>,
          glyph box <code>x52–148</code>, <code>y28–172</code>, shipped scaled
          <code>&times;5.12</code> onto 1024.</span></li>
        <li><span class="dot"></span><span><b>Stroke</b> — <code>28</code>, <code>butt</code>
          caps. Both terminals sit on a vertical tangent, so the cap lands as a flat
          stone cut rather than a round nib.</span></li>
        <li><span class="dot"></span><span><b>Bowls</b> — cubic controls pulled to the
          corners (<code>C146 38 126 28</code>) to square the curve. This is what
          separates it from a font&rsquo;s S.</span></li>
        <li><span class="dot"></span><span><b>Ground line</b> — <code>y126</code>, exactly
          where the two bowls lock. The accent is therefore a whole stratum; cut higher
          or lower and it becomes a sliver.</span></li>
        <li><span class="dot"></span><span><b>Signature tilt</b> — <code>&minus;15&deg;</code>,
          on the kicker square and list bullets, never on the mark.</span></li>
      </ul>
    </div>
    <div class="draw"><div class="grid-fig">{svg200(INK, ACCENT, "cn", size=250)}</div></div>
  </div>
</section>

<!-- 04 VARIATIONS -->
<section>
  <div class="sec-label"><span class="no">04</span><h2>Variations</h2>
    <span class="note">Three finishes. Same geometry — only the field and the accent step
    change.</span></div>
  <div class="vars">
    {variation("v1", INK, ACCENT, 1.0, "primary",
      "Paper", "Light surfaces: docs, the dashboard, print. Ink upper bowl, terracotta base.")}
    {variation("v2", PAPER_GLYPH, ACCENT_BRIGHT, 1.0, "inverse",
      "Reader", "Dark surfaces and the terminal. The accent steps up to bright so it holds "
      "against the ink field.", dark=True)}
    {variation("v3", INK, INK, 1.0, "single-colour",
      "Cut", "Etching, embossing, one-colour print, and any surface where the accent "
      "cannot be trusted to reproduce.")}
  </div>
</section>

<!-- 05 WORDMARK -->
<section>
  <div class="sec-label"><span class="no">05</span><h2>Wordmark</h2>
    <span class="note">Zilla Slab 700. Mark height = cap height; gap = half the mark.</span></div>
  <div class="lockups">
    <div class="lock">{svg200(INK, ACCENT, "w1", size=56)}<span class="name">Steadhold</span>
      <div class="rule"></div><span class="tag">Primary horizontal lockup. The slab&rsquo;s
      flat serifs answer the glyph&rsquo;s cut terminals.</span></div>
    <div class="lock dark">{svg200(PAPER_GLYPH, ACCENT_BRIGHT, "w2", size=56)}
      <span class="name">Steadhold</span><span class="tail">reader finish</span></div>
    <div class="lock sm">{svg200(INK, ACCENT, "w3", size=30)}<span class="name">Steadhold</span>
      <span class="tail">minimum — 23px cap</span></div>
  </div>
</section>

<!-- 06 LEGIBILITY -->
<section>
  <div class="sec-label"><span class="no">06</span><h2>Legibility</h2>
    <span class="note">The test that killed every earlier candidate: does it still read
    as an S at 16px?</span></div>
  <div class="legibility">
    <div class="lgrow">{legibility}</div>
    <div class="lgrow dark">{legibility_dark}</div>
  </div>
</section>

<!-- 07 PALETTE & TYPE -->
<section>
  <div class="sec-label"><span class="no">07</span><h2>Palette &amp; type</h2>
    <span class="note">Ink, paper, one accent in three steps. A second hue has to earn its
    place, and none has.</span></div>
  <div class="vars-pal">{sw}</div>
  <div class="type">
    <div class="tcard"><div class="lbl">Display</div>
      <div class="tsample-serif">Steadhold &mdash; own your backend</div>
      <p class="spec"><b>Zilla Slab</b> 600/700. Headings, the wordmark, section titles.
      Its flat slabs are the typographic echo of the glyph&rsquo;s stone cut.</p></div>
    <div class="tcard"><div class="lbl">Interface</div>
      <div class="tsample-sans">Projects &middot; Keys &middot; Storage &middot; Logs</div>
      <p class="spec"><b>Space Grotesk</b> 400/500/600. All UI, labels and body copy.
      Kickers are uppercase at <code>.20&ndash;.34em</code> tracking.</p></div>
  </div>
</section>

<footer>
  <span>Steadhold identity &middot; generated by <code>build-identity.py</code></span>
  <span>Assets: <code>design-exports/steadhold/logo/</code></span>
</footer>
</div></body></html>'''
    out = os.path.join(HERE, "identity.html")
    open(out, "w").write(html)
    print(f"  showcase → {out}")
    return out

if __name__ == "__main__":
    print("Steadhold identity")
    build_assets()
    build_showcase()
