# Ember UI kit: putting a release into an app

**Written:** 2026-10-09 21:32 UTC / 2026-10-09 17:32 EDT (Toronto)
**Source of this file:** `glass-ui-kit/docs/ADOPTING.md` on the VM (not hidden). A copy travels inside every release as `README.md`.

## What a release is

A frozen folder, `glass-ui-kit/releases/<version>/`. It is written once and never
edited. An app gets its own copy of one release and keeps it until someone deliberately
pins a newer one. Changing the kit cannot change an app.

| File | What it is |
|---|---|
| `ember-ui.css` | Every design value as a CSS variable, then the controls (both skins) |
| `ember-ui.js` | Control behaviour: sliders, segmented controls, skins |
| `glass/host-maplibre.js` | The glass, for an app whose backdrop is a MapLibre map |
| `glass/core.glsl.js`, `pack.js`, `tint.js`, `tokens.js` | The shader and its maths; loaded by the host |
| `tokens.json` | The parameter set this release was built from, for reference |
| `MANIFEST.json` | A checksum per file, so an edited copy can be detected |

## Pinning an app (run only on Blair's word)

`[VM]`
```
node glass-ui-kit/tools/kit-pin.mjs pulse 1.0.0
```
You should see: `pulse: legacy -> 1.0.0 at toronto-bike-pulse/kit`.
The app names come from `glass-ui-kit/apps.json`. Pinning copies files; the app
uses them only once its pages point at them (below). Test on the phone afterwards.

To see where every app stands:

`[VM]`
```
node glass-ui-kit/tools/kit-status.mjs
```

## Using it in a page

```html
<link href="kit/ember-ui.css?v=1.0.0" rel="stylesheet">
<script src="kit/ember-ui.js?v=1.0.0" defer></script>
```

Controls, no glass (an app with nothing behind it): white on black, wells.
```html
<div class="e-pane">
  <button class="e-btn">Cancel</button>
  <button class="e-btn e-btn--primary">Save</button>
</div>
```

Glass over a MapLibre map:
```js
import { createGlassLayer } from './kit/glass/host-maplibre.js?v=1.0.0';
map.on('load', () => map.addLayer(createGlassLayer()));   // add it LAST
```
```html
<div class="e-pane" data-glass data-skin="glass">
  <button class="e-btn">Filter</button>
  <button class="e-btn" data-tint="sapphire">Go</button>
</div>
```

- `data-glass` makes a pane. `data-skin="glass"` turns the buttons inside it into
  flush-mounted glass; `data-skin="well"` (or nothing) leaves them as inset wells.
- `data-tint` takes a palette name (ruby, amber, citrine, emerald, teal, sapphire,
  amethyst, rose) or any `#rrggbb`.
- Slider thumbs are opaque in both skins.

## Rules that are not optional

1. **Never edit the copy inside an app.** If something is wrong, fix it in
   `glass-ui-kit/src/`, cut a new version, and pin it. `kit-status` flags an
   edited copy.
2. **Nothing within 16 px of a pane's edge** (14 px for pills). That band bends the map.
3. **Panes do not nest.** Glass buttons inside a pane are fine.
4. **The glass skin only applies while the shader is drawing.** Until its first frame,
   after a failure, or after the phone drops the graphics context, every control shows
   its well skin. Do not style around that.
5. **Colour changes belong in the tokens**, not in an app's stylesheet.

## Making a new version

1. Change `glass-ui-kit/src/tokens.json` (and bump its `version`) or the files in
   `glass-ui-kit/src/`.
2. Judge it on the bench: https://dev.example.org
3. `[VM]` `node glass-ui-kit/tools/build.mjs release`
   It refuses if that version already exists.
4. Pin apps one at a time, on Blair's word.
