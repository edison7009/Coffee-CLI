import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/common/SettingsSlider.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  plugins: [{ name: 'slider-fixture', setup(builder) {
    builder.onResolve({ filter: /./ }, args => args.kind === 'entry-point' ? undefined : { path: args.path, namespace: 'fixture' });
    builder.onLoad({ filter: /./, namespace: 'fixture' }, args => ({ contents:
      args.path === 'react' ? 'export const useState = value => [value, () => {}]; export const useRef = value => ({ current: value });' :
      args.path === 'react/jsx-runtime' ? 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;' : '',
    }));
  } }],
});

function fixture(options = {}) {
  const applied = [], previews = [], captures = [];
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports });
  const tree = module.exports.SettingsSlider({
    label: 'Scale', value: 100, min: 70, max: 150, step: 10, commitOnRelease: true,
    onChange: value => applied.push(value), onPreview: value => previews.push(value), ...options,
  });
  const slider = tree.props.children.find(child => child?.type === 'input').props;
  const down = button => slider.onPointerDown({ button, pointerId: 1, currentTarget: { setPointerCapture: id => captures.push(id) } });
  const change = value => slider.onChange({ target: { value: String(value) } });
  return { slider, applied, previews, captures, down, change };
}

const drag = fixture(); drag.down(0);
for (const value of [103.5, 112.2, 125.6, 118.8]) drag.change(value);
assert.deepEqual(drag.applied, [], 'scale dragging must not resize the track or zoom the WebView');
assert.equal(drag.previews.at(-1), 120, 'percentage label updates only at snapped steps');
assert.deepEqual(drag.captures, [1]);
drag.slider.onPointerUp();
assert.deepEqual(drag.applied, [120], 'release applies the snapped latest position once');
assert.equal(drag.previews.at(-1), null);
drag.slider.onLostPointerCapture();
assert.equal(drag.applied.length, 1, 'capture release must not submit twice');

for (const cancel of ['onPointerCancel', 'onLostPointerCapture']) {
  const f = fixture(); f.down(0); f.change(145); f.slider[cancel](); f.slider.onPointerUp();
  assert.equal(f.applied.length, 0, 'cancelled scale drag must not change saved scale');
  assert.equal(f.previews.at(-1), null);
}
const keyboard = fixture();
for (const [key, expected] of [['Home', 70], ['End', 150], ['ArrowLeft', 90], ['ArrowRight', 110]]) {
  let prevented = false;
  keyboard.slider.onKeyDown({ key, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(keyboard.applied.at(-1), expected);
}
const click = fixture(); click.down(0); click.change(130); click.slider.onPointerUp();
assert.deepEqual(click.applied, [130]);

const opacity = fixture({ label: 'Opacity', value: 40, min: 0, max: 100, step: 5, commitOnRelease: false });
assert.equal(opacity.slider.step, 'any', 'wallpaper thumb must move continuously between 5% settings');
opacity.down(0); opacity.change(41); opacity.change(42); opacity.change(46); opacity.change(47); opacity.change(51);
assert.deepEqual(opacity.applied, [45, 50], 'wallpaper must update continuously before release');
opacity.slider.onPointerUp();
assert.deepEqual(opacity.applied, [45, 50], 'release must not repeat a live opacity update');
opacity.slider.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
assert.equal(opacity.applied.at(-1), 45, 'opacity keyboard steps stay at 5%');
const disabled = fixture({ disabled: true });
assert.equal(disabled.slider.disabled, true, 'missing wallpaper leaves the native range disabled');
const fineDrag = fixture(); fineDrag.down(0);
for (const value of [100.5, 101, 102, 103, 104]) fineDrag.change(value);
assert.deepEqual(fineDrag.previews, [100], 'sub-step movement must not re-render the parent settings panel');
assert.deepEqual(fineDrag.applied, []);
fineDrag.slider.onPointerUp();
assert.deepEqual(fineDrag.applied, [], 'returning to the current scale must not issue redundant native zoom');
console.log('OK: shared slider scale preview/release/cancel, keyboard, track click, live wallpaper updates, 5% steps, and disabled state');
