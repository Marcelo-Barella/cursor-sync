/** Bergamota sidebar design tokens (ground / surface / ink / hairline) for webview themes. */
export function renderSidebarAppearanceTokenCss(): string {
  return `
    html[data-theme="dark"] {
      --cs-ground: #14120b;
      --cs-surface-sunken: #0f0e0c;
      --cs-surface: #1c1a13;
      --cs-surface-hover: #22201a;
      --cs-surface-active: #1a1812;
      --cs-ink: #edecec;
      --cs-ink-80: rgba(237, 236, 236, 0.8);
      --cs-ink-70: rgba(237, 236, 236, 0.7);
      --cs-ink-60: rgba(237, 236, 236, 0.6);
      --cs-ink-55: rgba(237, 236, 236, 0.55);
      --cs-ink-40: rgba(237, 236, 236, 0.4);
      --cs-ink-32: rgba(237, 236, 236, 0.32);
      --cs-ink-30: rgba(237, 236, 236, 0.3);
      --cs-ink-22: rgba(237, 236, 236, 0.22);
      --cs-ink-10: rgba(237, 236, 236, 0.1);
      --cs-ink-08: rgba(237, 236, 236, 0.08);
      --cs-ink-06: rgba(237, 236, 236, 0.06);
      --cs-ink-05: rgba(237, 236, 236, 0.05);
      --cs-ink-12: rgba(237, 236, 236, 0.12);
      --cs-hairline: rgba(237, 236, 236, 0.08);
      --cs-hairline-soft: rgba(237, 236, 236, 0.06);
      --cs-hairline-strong: rgba(237, 236, 236, 0.12);
      --cs-btn-primary-bg: #ededec;
      --cs-btn-primary-fg: #0c0c0a;
      --cs-btn-primary-hover: rgba(237, 236, 236, 0.88);
      --cs-scroll-track: #161614;
      --cs-scroll-thumb: #2a2a28;
      --cs-scroll-thumb-hover: #3a3a37;
      --cs-shadow-soft: rgba(0, 0, 0, 0.3);
      --cs-shadow-strong: rgba(0, 0, 0, 0.4);
      --cs-segment-bg: var(--cs-surface-sunken);
      --cs-segment-active-bg: var(--cs-surface);
      --cs-segment-active-fg: var(--cs-ink);
    }

    html[data-theme="light"] {
      --cs-ground: #f3f2ee;
      --cs-surface-sunken: #e8e7e3;
      --cs-surface: #ffffff;
      --cs-surface-hover: #f0efeb;
      --cs-surface-active: #e5e4e0;
      --cs-ink: #14120b;
      --cs-ink-80: rgba(20, 18, 11, 0.82);
      --cs-ink-70: rgba(20, 18, 11, 0.72);
      --cs-ink-60: rgba(20, 18, 11, 0.62);
      --cs-ink-55: rgba(20, 18, 11, 0.55);
      --cs-ink-40: rgba(20, 18, 11, 0.45);
      --cs-ink-32: rgba(20, 18, 11, 0.38);
      --cs-ink-30: rgba(20, 18, 11, 0.34);
      --cs-ink-22: rgba(20, 18, 11, 0.28);
      --cs-ink-10: rgba(20, 18, 11, 0.1);
      --cs-ink-08: rgba(20, 18, 11, 0.08);
      --cs-ink-06: rgba(20, 18, 11, 0.06);
      --cs-ink-05: rgba(20, 18, 11, 0.05);
      --cs-ink-12: rgba(20, 18, 11, 0.12);
      --cs-hairline: rgba(20, 18, 11, 0.1);
      --cs-hairline-soft: rgba(20, 18, 11, 0.06);
      --cs-hairline-strong: rgba(20, 18, 11, 0.14);
      --cs-btn-primary-bg: #14120b;
      --cs-btn-primary-fg: #f3f2ee;
      --cs-btn-primary-hover: rgba(20, 18, 11, 0.88);
      --cs-scroll-track: #e8e7e3;
      --cs-scroll-thumb: #c9c8c4;
      --cs-scroll-thumb-hover: #b0afab;
      --cs-shadow-soft: rgba(20, 18, 11, 0.12);
      --cs-shadow-strong: rgba(20, 18, 11, 0.18);
      --cs-segment-bg: var(--cs-surface-sunken);
      --cs-segment-active-bg: var(--cs-surface);
      --cs-segment-active-fg: var(--cs-ink);
    }
  `;
}
