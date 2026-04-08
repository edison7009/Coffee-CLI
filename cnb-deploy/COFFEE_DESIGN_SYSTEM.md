# Coffee Design System
> Shared design language across Coffee CLI, Coffee Code, and Coffee OPC

## Brand Identity

| Property | Value |
|----------|-------|
| Primary Color | `#C4956A` (warm coffee) |
| Brand Font | Inter (English), PingFang SC / Noto Sans SC (CJK) |
| Mono Font | Cascadia Code, Cascadia Mono, Consolas |
| Border Radius | sm: 8px, md: 12px, lg: 16px |
| Transition | 0.2s ease |

---

## Color Palette

### Dark Theme (Claude-inspired)
```css
[data-theme="dark"] {
    --bg-app: #1e1d1b;
    --bg-panel: rgba(40, 39, 36, 0.95);
    --bg-card: rgba(46, 45, 42, 0.8);
    --bg-input: #35342f;
    --bg-input-focus: #3d3c37;
    --bg-hover: rgba(255, 255, 255, 0.05);
    --bg-active: rgba(255, 255, 255, 0.08);

    --border: rgba(255, 255, 255, 0.08);
    --border-input: rgba(255, 255, 255, 0.12);
    --border-focus: rgba(255, 255, 255, 0.25);

    --text-1: #e8e4de;
    --text-2: #b5b0a6;
    --text-3: #7a766e;

    --accent: #c4956a;
    --accent-hover: #d4a57a;
    --accent-active: #b5865c;
    --accent-bg: rgba(196, 149, 106, 0.12);

    --green: #7ec77e;
    --red: #e07070;
    --blue: #78a8d4;

    --shadow-panel: 0 8px 32px rgba(0, 0, 0, 0.3);
    --glass-blur: blur(24px);
    --bg-titlebar: rgba(0, 0, 0, 0.2);
    --bg-terminal: #1a1917;
}
```

### Light Theme (Claude Paper Style)
```css
[data-theme="light"] {
    --bg-app: #f4f3ee;
    --bg-panel: rgba(253, 252, 249, 0.95);
    --bg-card: #ffffff;
    --bg-input: #ffffff;
    --bg-input-focus: #ffffff;
    --bg-hover: rgba(0, 0, 0, 0.04);
    --bg-active: rgba(0, 0, 0, 0.08);

    --border: rgba(0, 0, 0, 0.08);
    --border-input: rgba(0, 0, 0, 0.12);
    --border-focus: rgba(196, 149, 106, 0.5);

    --text-1: #2d2c2a;
    --text-2: #6b6965;
    --text-3: #9e9c98;

    --accent: #c4956a;
    --accent-hover: #b5865c;
    --accent-active: #a1724d;
    --accent-bg: rgba(196, 149, 106, 0.12);

    --green: #34c759;
    --red: #ff3b30;
    --blue: #78a8d4;

    --shadow-panel: 0 4px 24px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.02);
    --glass-blur: blur(24px);
    --bg-titlebar: rgba(0, 0, 0, 0.04);
    --bg-terminal: #f4f3ee;
}
```

---

## Typography

```css
:root {
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC',
            'Noto Sans SC', 'Hiragino Sans GB', 'Microsoft YaHei',
            'Segoe UI', Roboto, Helvetica, Arial, sans-serif,
            'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
    --mono: 'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace;
}

body {
    font-family: var(--font);
    font-size: 14px;
}
```

---

## Dynamic Logo: Coffee Code (Animated SVG)

The Coffee Code logo is a fully animated SVG coffee cup with rising steam.
It uses CSS/SVG `<animate>` elements for:
- Steam rising animation (3s loop)
- Cup draw-on stroke animation (0.6s)
- Handle draw-on animation (0.3s delay)
- Fill fade-in (1.6s delay)

### React Component
```tsx
const SvgCoffeeCode = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <defs>
      <mask id="ccIconMask">
        {/* Steam paths - animated wave pattern */}
        <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
          d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4
             M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4
             M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
          <animate attributeName="d" dur="3s" repeatCount="indefinite"
            values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4
                    M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4
                    M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;
                    M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4
                    M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4
                    M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
        </path>
        {/* Cup body mask reveal */}
        <path d="M4 7h16v0h-16v12h16v-32h-16Z">
          <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s"
            to="M4 2h16v5h-16v12h16v-24h-16Z"/>
        </path>
      </mask>
    </defs>
    {/* Cup body + handle */}
    <g stroke="#C4956A" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
      {/* Cup body - stroke draw animation */}
      <path fill="#C4956A" fillOpacity="0" strokeDasharray="48"
        d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
        <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0"/>
        <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1"/>
      </path>
      {/* Handle */}
      <path fill="none" strokeDasharray="16" strokeDashoffset="16"
        d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
        <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0"/>
      </path>
    </g>
    {/* Steam (masked) */}
    <path fill="#C4956A" d="M0 0h24v24H0z" mask="url(#ccIconMask)"/>
  </svg>
);
```

### Raw SVG (standalone, no React)
```html
<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <mask id="ccIconMask">
      <path fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
        <animate attributeName="d" dur="3s" repeatCount="indefinite"
          values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
      </path>
      <path d="M4 7h16v0h-16v12h16v-32h-16Z">
        <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s" to="M4 2h16v5h-16v12h16v-24h-16Z"/>
      </path>
    </mask>
  </defs>
  <g stroke="#C4956A" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <path fill="#C4956A" fill-opacity="0" stroke-dasharray="48"
      d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
      <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0"/>
      <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1"/>
    </path>
    <path fill="none" stroke-dasharray="16" stroke-dashoffset="16"
      d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
      <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0"/>
    </path>
  </g>
  <path fill="#C4956A" d="M0 0h24v24H0z" mask="url(#ccIconMask)"/>
</svg>
```

---

## Design Principles

1. **Warm Tones** — All accent colors derive from `#C4956A` (coffee gold)
2. **Glassmorphism** — Panels use `rgba()` + `backdrop-filter: blur(24px)`
3. **Auto-hiding Scrollbars** — Thumb only appears on hover
4. **Micro-animations** — 0.2s ease transitions on all interactive elements
5. **Theme Duality** — Both dark and light must feel equally premium
6. **No Pure Black/White** — Dark uses `#1e1d1b`, light uses `#f4f3ee`

## Scrollbar Pattern
```css
* {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
}
*:hover {
    scrollbar-color: rgba(120, 120, 120, 0.4) transparent;
}
*::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
*::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
*:hover::-webkit-scrollbar-thumb { background: rgba(120, 120, 120, 0.3); }
```

---

## Product Family Naming

| Product | EN | ZH | Color Accent |
|---------|----|----|-------------|
| Coffee CLI | Coffee CLI | 咖啡办公 | #C4956A (primary) |
| Coffee Code | Coffee Code | 咖啡办公助手 | #C4956A (same) |
| Coffee OPC | Coffee OPC | 咖啡一人公司 | #C4956A (same base, can add secondary) |
