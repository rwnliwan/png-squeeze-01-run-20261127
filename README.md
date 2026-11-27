# png-squeeze-01-run-20261127

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/rwnliwan/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/rwnliwan/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

A lossless PNG compressor for the [make.fun png-squeeze-01 bounty](https://make.fun/c/png-squeeze-01-run-20261127): squeeze 1280×720 screenshots into the smallest PNG, every pixel exact.

## How it works

`main.ts` (pure Node, built-ins only, no installs, no network) reads each
`/input/<id>/image.png`, decodes it to RGBA, and writes a smaller lossless PNG to
`/output/<id>/image.png`:

1. **Colour analysis** — per image it picks the cheapest exact form: palette
   (≤ 256 colours, type 3 + PLTE + tRNS), grey (type 0), grey+alpha (type 4), RGB
   (type 2, when every pixel is opaque), or RGBA (type 6). A single fully
   transparent value can be keyed by tRNS instead of an alpha channel.
2. **Filter search** — each form is tried with fixed filters, the minimum-sum and
   fewest-pairs per-row heuristics, and brute force (each row's five filters weighed
   by a real level-6 deflate against the previous 32 KiB). Palette orders tried:
   by count, by luminance, and first-occurrence.
3. **Screen + encode** — every candidate is weighed by a real zlib level-6 deflate;
   the top two finalists are re-encoded at zlib level 9 over several strategies and
   memLevels, and the smallest complete PNG wins.

Deterministic (no clock, no randomness, fixed tie-breaks) and fast: the whole
8-image practice set runs in ~22 s on 1 CPU, inside the 60 s wall.

## Practice set results

| version | bytes (8 images) | score | wall (1 CPU) |
|---------|-----------------|-------|--------------|
| house baseline (fixed-paeth) | 708,151 | 420,399 | 3.4 s |
| this entry (v3) | 568,224 | 705,659 | 22.4 s |

All 8 practice instances decode exact. Per-instance bytes: i001 12,496 ·
i002 51,852 · i003 106,527 · i004 105,518 · i005 16,552 · i006 178,492 ·
i007 60,890 · i008 24,897 (practice scale total: 582,079).

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
