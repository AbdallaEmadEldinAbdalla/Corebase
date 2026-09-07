# Steadhold — identity

The mark, the assets, and an honest record of the four rounds it took.

## What ships

Everything in `logo/` is generated. **Do not hand-edit it** — change `SPINE` in
[`build-identity.py`](build-identity.py) and re-run:

```bash
python3 design-exports/steadhold/build-identity.py
```

| File | What it is |
|---|---|
| `logo/logo-paper.svg` | Master, 1024 grid, ink + terracotta, transparent. Light surfaces. |
| `logo/logo-reader.svg` | Master, 1024 grid, paper + bright terracotta. Dark surfaces. |
| `logo/favicon.svg` | Reader finish on an `rx220` ink field — the one place a field is allowed (D-410). |
| `logo/favicon.ico` | 16 / 32 / 48, assembled from the PNGs below. |
| `logo/favicon-{16,32,48}.png` | Rasterised from `favicon.svg`. |
| `logo/icon-maskable.svg` | Full-bleed, glyph at `0.82` to clear the maskable safe radius. |
| `logo/icon-{192,512}.png` | PWA. `192` is `any maskable`, `512` is the splash. |
| `logo/apple-touch-icon.png` | 180, opaque — iOS refuses alpha. |
| `identity.html` | The 01–07 showcase: philosophy, mark, construction, variations, wordmark, legibility, palette. |

Rasterisation runs through headless Chrome, because `rsvg-convert` and
ImageMagick are not installed here (D-409).

## The mark

A **chiselled S, cut at the waist**. The upper bowl is ink; the lower bowl is
terracotta — the stratum the letter stands in. One idea: *founded, not rented*.

- `viewBox 0 0 200 200`, glyph box `x52–148` / `y28–172`, shipped `×5.12` on 1024
- stroke `28`, `butt` caps — both terminals sit on a vertical tangent, so the cap
  lands as a flat stone cut rather than a round nib
- cubic controls pulled to the corners (`C146 38 126 28`) to square the curves;
  this is what separates it from a font's S
- the ground line is `y126`, exactly where the two bowls lock

Palette: ink `#171310`, paper `#FAF6F0`, terracotta `#B4502E` (deep `#8E3D22`,
bright `#E07A52`). Type: Zilla Slab 600/700 display, Space Grotesk 400/500/600 UI.
Signature tilt `−15°`, used on kicker squares and bullets — never on the mark.

## The rounds, and what was cut

Kept as an audit trail. Open them; every rejection below was made by looking at a
screenshot, not by reading SVG.

| File | Round | Outcome |
|---|---|---|
| `candidates.html` | 1 — ten ideas | 8 cut. Plot/Fold/Gutter read as a capital **E** (the knockouts destroy the S); Boundary read as a crop marquee; Module was dot-matrix mush at 16px; Keep blobbed; Held read as a code placeholder; Terrace was invisible. |
| `round2.html` | 2 — the survivors plus five masonry ideas | All cut. Course read as a *misaligned* S; Footing's two stacked bars read as a hamburger menu; Keystone's wedge made the S look dented; Seam read as a **strikethrough**, which is poison for a brand. |
| `refine.html`, `rebuild.html` | 2b — refining the "winner" | **The whole direction died here.** A blocky S built from three bars and two stems *is* a numeral 5 — a 5 is that construction minus one corner, and that corner is the first thing to go at favicon size. No amount of proportion fixing rescues it. |
| `round3.html` | 3 — a real curved-bowl S, plus letterless marks | Strata shattered the letter; Deed collided with the bowl; Grip's accent block floated off the stroke; Keystone became three rectangles at 16px. Survivors: the accent-square pin, and the letterless Plinth and Held. |
| `round4.html` | 4 — the chiselled S, six accent placements | **Accent lower bowl wins.** Pin and terminal read as rendering defects; the waist bar reads as an accidental tab; the plinth is an underline again; the seam is more than half accent and snaps the top into a "7". |
| `cut.html` | 4b — where the ground line cuts | `y126` (the waist). `y112` leaves an orange shard on the upper diagonal; `y140` leaves a crescent that reads as a drop shadow at 16px; a 3px gutter breaks the letter again. |

The lesson worth keeping: **bars cannot make an S.** Only the two opposing curved
bowls distinguish it from a 5, and 16px is the test that proves it.
