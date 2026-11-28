// Customizable Theme Engine for AGY Claude Style (v4.0.0).
// Supports 8 curated dual-mode presets + 8-token custom palette derivation with strict hex validation.
// Registers on globalThis.__agCsThemeEngine (and exports for Node tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__agCsThemeEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const THEME_STYLE_ID = 'ag-claude-style-theme-vars';
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  const CUSTOM_COLOR_KEYS = ['accent', 'canvas', 'sidebar', 'composer', 'bubble', 'fg', 'mutedFg', 'border'];
  const BASE_PRESET_IDS = ['obsidian', 'claude', 'nord', 'catppuccin', 'rosepine', 'tokyo', 'dracula', 'emerald'];
  const ALL_PALETTE_IDS = [...BASE_PRESET_IDS, 'custom', 'host'];

  const PRESETS = {
    obsidian: {
      dark: {
        accent: '#4d6bfe',
        canvas: '#13161d',
        sidebar: '#13161d',
        composer: '#0e1117',
        bubble: '#262b36',
        fg: '#f4f9ff',
        mutedFg: '#88929f',
        border: '#23262e',
      },
      light: {
        accent: '#4d6bfe',
        canvas: '#fbfcff',
        sidebar: '#f7f9ff',
        composer: '#ffffff',
        bubble: '#ecf0ff',
        fg: '#131416',
        mutedFg: '#646871',
        border: '#e3e6ef',
      },
    },
    claude: {
      dark: {
        accent: '#d97757',
        canvas: '#191919',
        sidebar: '#1f1f1f',
        composer: '#141414',
        bubble: '#292929',
        fg: '#fdfdfd',
        mutedFg: '#9c9395',
        border: '#2c2c2c',
      },
      light: {
        accent: '#d97757',
        canvas: '#ffffff',
        sidebar: '#fafafa',
        composer: '#ffffff',
        bubble: '#f4f2f3',
        fg: '#161616',
        mutedFg: '#70696b',
        border: '#e9e9e9',
      },
    },
    nord: {
      dark: {
        accent: '#88c0d0',
        canvas: '#242933',
        sidebar: '#20242e',
        composer: '#2e3440',
        bubble: '#3b4252',
        fg: '#eceff4',
        mutedFg: '#9aa5b8',
        border: '#3b4252',
      },
      light: {
        accent: '#5e81ac',
        canvas: '#f4f6fa',
        sidebar: '#eceff4',
        composer: '#ffffff',
        bubble: '#e5e9f0',
        fg: '#2e3440',
        mutedFg: '#626d80',
        border: '#d8dee9',
      },
    },
    catppuccin: {
      dark: {
        accent: '#cba6f7',
        canvas: '#1e1e2e',
        sidebar: '#181825',
        composer: '#11111b',
        bubble: '#313244',
        fg: '#cdd6f4',
        mutedFg: '#a6adc8',
        border: '#313244',
      },
      light: {
        accent: '#8839ef',
        canvas: '#eff1f5',
        sidebar: '#e6e9ef',
        composer: '#ffffff',
        bubble: '#dce0e8',
        fg: '#4c4f69',
        mutedFg: '#6c6f85',
        border: '#ccd0da',
      },
    },
    rosepine: {
      dark: {
        accent: '#ebbcba',
        canvas: '#191724',
        sidebar: '#15131f',
        composer: '#1f1d2e',
        bubble: '#26233a',
        fg: '#e0def4',
        mutedFg: '#908caa',
        border: '#2a273f',
      },
      light: {
        accent: '#b4637a',
        canvas: '#faf4ed',
        sidebar: '#f2e9e1',
        composer: '#fffaf3',
        bubble: '#efe5dc',
        fg: '#575279',
        mutedFg: '#797593',
        border: '#dfdad9',
      },
    },
    tokyo: {
      dark: {
        accent: '#7aa2f7',
        canvas: '#1a1b26',
        sidebar: '#16161e',
        composer: '#13141c',
        bubble: '#24283b',
        fg: '#c0caf5',
        mutedFg: '#787c99',
        border: '#292e42',
      },
      light: {
        accent: '#34548a',
        canvas: '#e1e2e7',
        sidebar: '#d5d6db',
        composer: '#f2f3f7',
        bubble: '#cfd1da',
        fg: '#343b58',
        mutedFg: '#565a6e',
        border: '#c2c4ce',
      },
    },
    dracula: {
      dark: {
        accent: '#bd93f9',
        canvas: '#1e1f29',
        sidebar: '#191a23',
        composer: '#15161e',
        bubble: '#2d303f',
        fg: '#f8f8f2',
        mutedFg: '#9da5c4',
        border: '#343746',
      },
      light: {
        accent: '#7c3aed',
        canvas: '#f8f7fc',
        sidebar: '#f0eef7',
        composer: '#ffffff',
        bubble: '#e8e4f5',
        fg: '#282a36',
        mutedFg: '#6272a4',
        border: '#dcd7ec',
      },
    },
    emerald: {
      dark: {
        accent: '#34d399',
        canvas: '#0f1715',
        sidebar: '#0b1210',
        composer: '#131d1a',
        bubble: '#1a2a25',
        fg: '#ecfdf5',
        mutedFg: '#86a399',
        border: '#1f332c',
      },
      light: {
        accent: '#059669',
        canvas: '#f4fbf8',
        sidebar: '#eaf6f1',
        composer: '#ffffff',
        bubble: '#dff2ea',
        fg: '#0f241d',
        mutedFg: '#4c6b60',
        border: '#cde3da',
      },
    },
  };

  function isValidHexColor(val) {
    return typeof val === 'string' && HEX_RE.test(val.trim());
  }

  function hexToRgb(hex) {
    const clean = String(hex || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return [128, 128, 128];
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }

  function rgbToHex(r, g, b) {
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
  }

  function mixHex(hexA, hexB, weightB = 0.5) {
    const w = Math.max(0, Math.min(1, Number(weightB) || 0));
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    return rgbToHex(
      a[0] + (b[0] - a[0]) * w,
      a[1] + (b[1] - a[1]) * w,
      a[2] + (b[2] - a[2]) * w
    );
  }

  function rgbaStr(hex, alpha = 1) {
    const [r, g, b] = hexToRgb(hex);
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }

  function relativeLuminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function normalizeCustomTheme(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    if (typeof raw.base === 'string' && BASE_PRESET_IDS.includes(raw.base)) {
      out.base = raw.base;
    }
    if (typeof raw.mode === 'string' && (raw.mode === 'auto' || raw.mode === 'dark' || raw.mode === 'light')) {
      out.mode = raw.mode;
    }
    for (const k of CUSTOM_COLOR_KEYS) {
      if (typeof raw[k] === 'string' && isValidHexColor(raw[k])) {
        out[k] = raw[k].trim().toLowerCase();
      }
    }
    return out;
  }

  function resolveEffectiveDark(cfg, hostIsDark) {
    if (cfg && cfg.palette === 'custom') {
      const ct = normalizeCustomTheme(cfg.customTheme);
      if (ct.mode === 'dark') return true;
      if (ct.mode === 'light') return false;
      if (ct.canvas) return relativeLuminance(ct.canvas) < 0.42;
    }
    return Boolean(hostIsDark);
  }

  function resolveCoreTokens(palette, customTheme, dark) {
    const ct = normalizeCustomTheme(customTheme);
    const baseId = palette === 'custom'
      ? (ct.base && PRESETS[ct.base] ? ct.base : 'obsidian')
      : (PRESETS[palette] ? palette : 'obsidian');
    const modeKey = dark ? 'dark' : 'light';
    const baseTokens = PRESETS[baseId][modeKey];
    if (palette !== 'custom') {
      return { ...baseTokens };
    }
    return {
      accent: ct.accent || baseTokens.accent,
      canvas: ct.canvas || baseTokens.canvas,
      sidebar: ct.sidebar || baseTokens.sidebar,
      composer: ct.composer || baseTokens.composer,
      bubble: ct.bubble || baseTokens.bubble,
      fg: ct.fg || baseTokens.fg,
      mutedFg: ct.mutedFg || baseTokens.mutedFg,
      border: ct.border || baseTokens.border,
    };
  }

  function buildThemeCss(palette, customTheme, dark) {
    if (!palette || palette === 'obsidian' || palette === 'claude' || palette === 'host') {
      return '';
    }
    const tokens = resolveCoreTokens(palette, customTheme, dark);
    const { accent, canvas, sidebar, composer, bubble, fg, mutedFg, border } = tokens;

    const card = dark ? mixHex(canvas, fg, 0.05) : mixHex(canvas, '#ffffff', 0.65);
    const secondary = dark ? mixHex(canvas, fg, 0.08) : mixHex(canvas, '#000000', 0.045);
    const muted = dark ? mixHex(canvas, fg, 0.045) : mixHex(canvas, '#000000', 0.03);
    const secondaryFg = mixHex(fg, mutedFg, 0.38);
    const placeholder = mixHex(mutedFg, canvas, 0.32);
    const border2 = mixHex(border, fg, dark ? 0.14 : 0.12);
    const accentHover = mixHex(accent, dark ? '#ffffff' : '#000000', 0.16);
    const link = dark ? mixHex(accent, '#ffffff', 0.28) : mixHex(accent, '#000000', 0.18);
    const primaryFg = relativeLuminance(accent) > 0.56 ? '#131416' : '#fbfcff';
    const panelBg = rgbaStr(mixHex(canvas, fg, dark ? 0.10 : 0.04), 0.94);
    const tileBg = rgbaStr(mixHex(canvas, fg, dark ? 0.18 : 0.09), dark ? 0.84 : 0.74);
    const pillBg = rgbaStr(composer, dark ? 0.72 : 0.84);
    const scrim = dark ? 'rgba(7, 9, 13, 0.72)' : 'rgba(19, 20, 22, 0.34)';

    const effortLow = dark ? mixHex(accent, canvas, 0.12) : mixHex(accent, fg, 0.06);
    const effortMed = accent;
    const effortHigh = dark ? mixHex(accent, fg, 0.22) : mixHex(accent, '#000000', 0.18);
    const effortXHigh = dark ? mixHex(accent, fg, 0.42) : mixHex(accent, '#000000', 0.34);
    const rippleWave = dark ? mixHex(accent, '#ffffff', 0.25) : accent;

    const selHeader = [
      `html[data-ag-cs-style][data-ag-cs-palette="${palette}"][data-ag-cs-theme="${dark ? 'dark' : 'light'}"]`,
      `html[data-ag-cs-style][data-ag-cs-palette="${palette}"]`,
    ].join(',\n');

    return `${selHeader} {
  color-scheme: ${dark ? 'dark' : 'light'} !important;

  --background: ${canvas} !important;
  --content: ${canvas} !important;
  --shell: ${canvas} !important;
  --body-background: ${canvas} !important;
  --foreground: ${fg} !important;

  --sidebar: ${sidebar} !important;
  --sidebar-secondary: ${bubble} !important;
  --sidebar-muted: ${muted} !important;

  --card: ${card} !important;
  --card-border: ${border2} !important;
  --border: ${border} !important;
  --glass: ${card} !important;
  --glass-border: ${border2} !important;

  --secondary: ${secondary} !important;
  --secondary-foreground: ${secondaryFg} !important;
  --muted: ${muted} !important;
  --muted-foreground: ${mutedFg} !important;
  --placeholder: ${placeholder} !important;

  --primary: ${accent} !important;
  --primary-foreground: ${primaryFg} !important;
  --link: ${link} !important;
  --error: #ef8585 !important;
  --warning: #e2a45f !important;
  --success: #63c59a !important;
  --code-foreground: ${fg} !important;
  --home-glow: transparent !important;
  --scrim: ${scrim} !important;
  --glass-highlight: transparent !important;

  --onyx-frame: ${composer} !important;
  --onyx-well: ${muted} !important;
  --onyx-raised: ${card} !important;
  --onyx-selected: ${dark ? rgbaStr(fg, 0.08) : bubble} !important;
  --onyx-key: ${mixHex(card, fg, dark ? 0.14 : 0.04)} !important;

  --fg-cursor: ${accent} !important;
  --ag-user-bubble: ${bubble};
  --ag-composer-border: ${border2};
  --ag-composer-border-focus: ${rgbaStr(fg, 0.24)};
  --ag-accent-fill: ${accent};
  --ag-accent-fill-hover: ${accentHover};
  --ag-focus: ${rgbaStr(accent, 0.55)};
  --ag-selection: ${rgbaStr(accent, dark ? 0.28 : 0.22)};
  --ag-scroll-thumb: ${rgbaStr(mutedFg, 0.42)};
  --ag-scroll-thumb-active: ${rgbaStr(mutedFg, 0.72)};
  --ag-sidebar-text: ${secondaryFg};
  --ag-sidebar-text-strong: ${fg};
  --ag-sidebar-label: ${mutedFg};

  --focus-ring-color: ${rgbaStr(accent, 0.45)} !important;
  --focus-ring-offset-color: ${canvas} !important;
  --bg-selection: ${rgbaStr(accent, dark ? 0.28 : 0.22)} !important;

  --ag-cs-canvas: ${canvas};
  --ag-cs-sidebar: ${sidebar};
  --ag-cs-composer-bg: ${composer};
  --ag-cs-panel-bg: ${panelBg};
  --ag-cs-tile-bg: ${tileBg};
  --ag-cs-tile-border: transparent;
  --ag-cs-pill-bg: ${pillBg};
  --ag-cs-pill-border: ${rgbaStr(fg, 0.14)};
  --ag-cs-tab-active: ${dark ? mixHex(card, fg, 0.14) : rgbaStr(fg, 0.09)};
  --ag-cs-bubble: ${bubble};
  --ag-cs-border-1: ${border};
  --ag-cs-border-2: ${border2};
  --ag-cs-hover-wash: ${rgbaStr(fg, 0.08)};
  --ag-cs-focus-ring: ${rgbaStr(fg, 0.22)};
  --ag-cs-focus-halo: ${rgbaStr(fg, 0.08)};
  --ag-cs-composer-shadow: ${dark ? '0 4px 14px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.18)' : '0 4px 12px rgba(20, 20, 19, 0.05), 0 1px 3px rgba(20, 20, 19, 0.03)'};
  --ag-cs-accent: ${accent};
  --ag-cs-data-ink: ${accent};
  --ag-cs-heat-empty: ${rgbaStr(fg, 0.11)};
  --ag-cs-ripple-ink: ${mutedFg};
  --ag-cs-ripple-wave: ${rippleWave};
  --ag-cs-effort-low: ${effortLow};
  --ag-cs-effort-med: ${effortMed};
  --ag-cs-effort-high: ${effortHigh};
  --ag-cs-effort-xhigh: ${effortXHigh};
  --ag-cs-tip-bg: ${fg};
  --ag-cs-tip-fg: ${canvas};
  --ag-cs-scroll: ${rgbaStr(mutedFg, 0.42)};
  --ag-cs-scroll-hover: ${rgbaStr(mutedFg, 0.72)};

  --vscode-editor-background: ${canvas} !important;
  --vscode-editorGutter-background: ${canvas} !important;
  --vscode-sideBar-background: ${sidebar} !important;
  --vscode-panel-background: ${canvas} !important;
  --vscode-titleBar-activeBackground: ${canvas} !important;
  --vscode-button-background: ${accent} !important;
  --vscode-button-hoverBackground: ${accentHover} !important;
  --vscode-textLink-foreground: ${link} !important;
}`;
  }

  function removeThemeStyle(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return;
    const el = doc.getElementById(THEME_STYLE_ID);
    if (el && typeof el.remove === 'function') el.remove();
  }

  function syncThemeStyle(doc, cfg, hostIsDark) {
    if (!doc) return '';
    const palette = cfg && typeof cfg.palette === 'string' ? cfg.palette : 'obsidian';
    const dark = resolveEffectiveDark(cfg, hostIsDark);
    const css = buildThemeCss(palette, cfg?.customTheme, dark);
    if (!css) {
      removeThemeStyle(doc);
      return '';
    }
    const targetParent = doc.head || doc.documentElement;
    if (!targetParent) return css;
    let style = typeof doc.getElementById === 'function' ? doc.getElementById(THEME_STYLE_ID) : null;
    if (!style) {
      style = doc.createElement('style');
      style.id = THEME_STYLE_ID;
    }
    if (style.textContent !== css) style.textContent = css;
    if (style.parentNode !== targetParent || targetParent.lastElementChild !== style) {
      targetParent.appendChild(style);
    }
    return css;
  }

  return {
    THEME_STYLE_ID,
    CUSTOM_COLOR_KEYS,
    BASE_PRESET_IDS,
    ALL_PALETTE_IDS,
    PRESETS,
    isValidHexColor,
    hexToRgb,
    rgbToHex,
    mixHex,
    rgbaStr,
    relativeLuminance,
    normalizeCustomTheme,
    resolveEffectiveDark,
    resolveCoreTokens,
    buildThemeCss,
    syncThemeStyle,
    removeThemeStyle,
  };
});
