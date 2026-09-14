---
"aicodeman": patch
---

Fix an invisible terminal text selection on the light skins (#360). Every xterm palette declared its selection colour under the key `selection`, which xterm.js renamed to `selectionBackground` in v5. An `ITheme` is a plain object, so the unknown key was dropped without an error and every skin fell back to xterm's own default of `rgba(255,255,255,0.3)`: unnoticeable on the dark skins, which wanted roughly that anyway, and effectively invisible on Paper Gray, Solarized Light, Catppuccin Latte and Rosé Pine Dawn, where white at 30% over a near-white background moves a channel by about 3/255. Selecting text on those skins now highlights it, with desktop drag-select and the mobile long-press both fixed by the same rename.
