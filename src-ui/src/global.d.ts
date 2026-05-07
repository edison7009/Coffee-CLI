/// <reference types="vite/client" />

// Build-time platform constant injected by vite.config.ts via `define`.
// True iff the binary was built on a Linux CI runner. Used to gate
// CPU-expensive WebKit2GTK animations (SMIL path morphs in masks, dot
// grids with box-shadow opacity loops) that are essentially free on
// WebView2 / WKWebView but peg cores on TextureMapper + Cairo.
declare const __IS_LINUX__: boolean;
