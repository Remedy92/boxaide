# Connector logos

Each file is the vendor's own mark, downloaded from the vendor's own site on
2026-08-20 and used only to identify that vendor on the Connectors screen.
Nothing here is redrawn, and nothing is fetched at runtime: the files are
served by the Boxaide web app itself, so a self-hosted install makes no
request to a vendor just to draw a row.

| File | Source |
| --- | --- |
| `apollo.png` | `https://apollo.io/icon.svg` (the embedded bitmap, scaled to 96px) |
| `hunter.png` | `https://hunter.io/assets/touch-icon-iphone-retina-toekunmu.png`, scaled to 96px |
| `prospeo.png` | `https://prospeo.io/favicon/apple-touch-icon.png`, scaled to 96px |
| `exa.svg` | the bracket mark from `https://exa.ai/images/logo/exa-logo-blue.svg` |
| `parallel.svg` | `https://parallel.ai/views/icons/logo-parallel.svg` |

The two SVGs were re-wrapped so they scale: fixed `width`/`height` attributes
were removed and the `viewBox` kept. No path data was touched.

`parallel.svg` is a single-colour mark, so the panel inverts it in the dark
theme rather than leaving near-black art on a near-black surface. The other
four carry their own brand colours in both themes.

Each mark stays the property of its owner. Replacing one is a matter of
dropping in the vendor's current file and updating the row above.
