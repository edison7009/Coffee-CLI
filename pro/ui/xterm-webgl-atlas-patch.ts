// xterm's WebGL addon 0.19 corrupts glyphs once its texture atlas starts merging
// pages (long CJK output reaches that quickly, since every character and colour
// pair takes its own atlas entry). Several upstream defects combine:
//
//  1. AtlasPage.version only counts per page, so a page shifted or merged into
//     a texture slot can match that slot's old version and keep the old texture.
//  2. A merge during _updateModel leaves the cells written earlier in that frame
//     pointing at stale pages.
//  3. The "model is stale" signal is one shared flag, not per renderer.
//  4. Every texture upload regenerates mipmaps, which the fixes above make
//     more frequent on pages up to the device's maximum texture size.
//  5. Once no four pages can merge, the atlas outgrows the renderer's textures.
//     The oversized-glyph page skips that path too, so rendering also clamps.
//
// Backported from xtermjs/xterm.js PR 6042, 5987 and the later page-cap and
// render-loop work, as minified-bundle edits because no stable release carries
// them yet. A bundle that already has pageLayoutVersion is left alone, so this
// can be deleted after upgrading. Any other mismatch throws: shipping unpatched
// would bring the garbled output back with no visible sign.
export function patchXtermWebglAtlas(source: string): string {
  if (source.includes('pageLayoutVersion')) return source;

  const edit = (code: string, pattern: RegExp, replacement: string, sites: number): string => {
    const found = code.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
    if (found !== sites) {
      throw new Error(`[patch-xterm-webgl-atlas] expected ${sites} of ${pattern} in the addon bundle, found ${found}`);
    }
    return code.replace(new RegExp(pattern.source, 'g'), replacement);
  };

  let code = edit(source, /\b([\w$]+)\.version\+\+/, '$1.version=++__coffeeAtlasVersion', 4);
  code = edit(
    code,
    /this\._requestClearModel=!0/,
    'this._requestClearModel=!0,this.pageLayoutVersion=(this.pageLayoutVersion||0)+1',
    2,
  );
  code = edit(
    code,
    /beginFrame\(\)\{return(?: this\._atlas\?this\._atlas\.beginFrame\(\):!0|!this\._atlas\|\|this\._atlas\.beginFrame\(\))\}/,
    'invalidateAtlasTextures(){for(const t of this._atlasTextures)t.version=-1}'
      + 'beginFrame(){if(!this._atlas)return!0;const t=this._atlas.pageLayoutVersion||0;'
      + 'return t!==this._lastSeenPageLayoutVersion&&(this._lastSeenPageLayoutVersion=t,!0)}',
    1,
  );
  code = edit(
    code,
    /setAtlas\(([\w$]+)\)\{this\._atlas=\1/,
    'setAtlas($1){this._lastSeenPageLayoutVersion=void 0,this._atlas=$1',
    1,
  );
  code = edit(
    code,
    /(this\._glyphRenderer\.value\.beginFrame\(\)\?\(this\._clearModel\(!0\),this\._updateModel\(0,this\._terminal\.rows-1\)\):this\._updateModel\([\w$]+,[\w$]+\),)/,
    '$1(()=>{let t=!1,n=0;for(;this._charAtlas&&this._glyphRenderer.value.beginFrame();){'
      + 'if(n++>=3){this._glyphRenderer.value._lastSeenPageLayoutVersion=void 0,this._requestRedrawViewport();break}'
      + 't=!0,this._clearModel(!0),this._updateModel(0,this._terminal.rows-1)}'
      + 't&&this._glyphRenderer.value.invalidateAtlasTextures()})(),',
    1,
  );
  code = edit(
    code,
    /for\(let ([\w$]+)=0;\1<this\._atlas\.pages\.length;\1\+\+\)this\._atlas\.pages\[\1\]\.version!==/,
    'for(let $1=0;$1<Math.min(this._atlas.pages.length,this._atlasTextures.length);$1++)this._atlas.pages[$1].version!==',
    1,
  );
  code = edit(
    code,
    /([\w$]+)\.generateMipmap\(\1\.TEXTURE_2D\)/,
    '$1.texParameteri($1.TEXTURE_2D,$1.TEXTURE_MIN_FILTER,$1.LINEAR),'
      + '$1.texParameteri($1.TEXTURE_2D,$1.TEXTURE_MAG_FILTER,$1.LINEAR)',
    1,
  );
  code = edit(
    code,
    /_createNewPage\(\)\{if\(([\w$]+)\.maxAtlasPages&&/,
    '_evictWhenUnmergeable(t){if(!t.maxAtlasPages||this._pages.length<Math.max(4,t.maxAtlasPages))return;'
      + 'const n=t.maxTextureSize||4096,s=new Map;'
      + 'for(const o of this._pages)if(o.canvas.width*2<=n){const r=(s.get(o.canvas.width)||0)+1;if(r===4)return;s.set(o.canvas.width,r)}'
      + 'for(const o of this._pages)this._onRemoveTextureAtlasCanvas.fire(o.canvas),o.canvas.remove();'
      + 'this._pages.length=0,this._activePages.length=0,this._overflowSizePage=void 0,'
      + 'this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1,'
      + 'this.pageLayoutVersion=(this.pageLayoutVersion||0)+1}'
      + '_createNewPage(){this._evictWhenUnmergeable($1);if($1.maxAtlasPages&&',
    1,
  );
  return `let __coffeeAtlasVersion=0;${code}`;
}
