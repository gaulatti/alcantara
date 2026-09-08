# Giorgia podcast player

Add **Modo Italiano Giorgia Podcast Player** (`modoitaliano-giorgia-podcast-player`)
from the scene component catalog. It is independent of the original podcast
player, which remains available and unchanged.

The existing podcast editor supplies Show Player, Episode Title, Show / Author,
Audio URL and Cover Art. Metadata is saved under the new component ID and rendered
through the normal program scene path. Output master gain still controls audio.

The 1920 × 1080 composition uses a single full-bleed, center-center cropped cover,
a continuous photo/navy fade, and oversized uppercase Barlow Condensed text
anchored by a vertical magenta rule. Playback lives in a restrained full-width
footer. A single white ModoItaliano logo sits in the upper-left safe area,
matching the Giorgia YouTube thumbnail placement scaled to 1920 × 1080,
using the shared `/mi.svg` asset without a surrounding panel. Playback uses a
magenta spectrum and focus-visible seek control; there is no separate
cover card. Long titles wrap rather than being
ellipsized. The cover is optional and its absence is explicitly shown.

Playback starts when audio becomes ready; browsers that require interaction show
a Start playback button. Audio failures are visible. The progress slider supports
keyboard and pointer seeking. Hiding the component pauses playback. Reduced-motion
preferences replace the live spectrum with a static line.

The component preview gallery includes a silent visual fixture; it never starts
an external podcast automatically. Supply an audio URL in the scene editor to
exercise playback and output gain in the program renderer.
