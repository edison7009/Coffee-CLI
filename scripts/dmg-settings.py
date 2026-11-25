# Coffee CLI — dmgbuild settings for the macOS drag-to-install DMG.
#
# dmgbuild writes the Finder window layout (.DS_Store) directly, so it works
# on headless CI runners where Tauri's AppleScript-driven layout is skipped.
#
#   dmgbuild -s scripts/dmg-settings.py -D app="path/to/Coffee CLI.app" \
#            "Coffee CLI" out.dmg
#
# Icon positions and window size MUST match scripts/build-dmg-background.py,
# which draws the arrow and text behind these icons.

import os.path

_app = defines["app"]  # noqa: F821  (injected by dmgbuild)
_here = defines.get("root", os.getcwd())  # noqa: F821  repo root; run from there
_app_name = os.path.basename(_app)

format = "UDZO"
compression_level = 9
filesystem = "HFS+"
size = None

files = [_app]
symlinks = {"Applications": "/Applications"}
# No hide_extensions: it writes a Finder-info flag onto the bundle itself,
# which `codesign --verify --strict` rejects as detritus and which travels
# with the app when it is dragged to /Applications. Finder hides ".app" anyway.

icon = os.path.join(_here, "icons", "icon.icns")
background = os.path.join(_here, "icons", "dmg", "background.png")  # @2x picked up automatically

show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

# (x, y) of the window's top-left on screen, then its frame size: the 400pt
# background plus Finder's title bar (~28pt on current macOS).
window_rect = ((200, 160), (660, 428))
default_view = "icon-view"
show_icon_preview = False

arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
scroll_position = (0, 0)
label_pos = "bottom"
text_size = 13
icon_size = 128

icon_locations = {
    _app_name: (170, 186),
    "Applications": (490, 186),
}
