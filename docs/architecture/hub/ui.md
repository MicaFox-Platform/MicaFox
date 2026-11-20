# Hub UI kit

## Purpose

`@micafox/ui` is the hub's look: design tokens, fonts, icons and React components in a retro operating-system style.
The shell, every feature and `ee/` build their screens from it and have no styles of their own.

## Boundaries

- Owns:
  - the tokens: color, type, spacing, radius, borders, elevation, motion, as CSS custom properties;
  - the light and dark themes;
  - the components, their keyboard and focus behavior, and the fonts and icons they use;
  - the check that the tokens' color pairs meet the contrast they promise.
- Does not own: screens and routes: [web](web.md); the logo and the fox mascot, which replace the placeholder
  wordmark before launch ([Deferred](overview.md#deferred)).
- Constraints:
  - MIT, so the style can be reused anywhere, such as the website and the docs.
  - No CSS outside this package: ESLint rejects `.css` imports, `className` and `style` in the shell, the features
    and `ee/`.
  - Fonts are OFL and icons MIT, shipped inside the image; nothing loads from another origin.

## Interactions

```text
┌──────── @micafox/ui ─────────┐  components, tokens.css  ┌──────────────────────────────────────┐
│ tokens · themes · fonts      │─────────────────────────▶│ hub-core web shell, features, ee/    │
│ components (React Aria)      │                          │ no CSS of their own                  │
└──────────────────────────────┘                          └──────────────────────────────────────┘
```

### Style

The style is a retro operating system: a paper-colored desktop, windows with title bars and hard 1 px borders,
shadows offset without blur and filled with a dither pattern, dotted rules between sections, uppercase labels,
buttons and tabs written as `[ LABEL ]`, and a neon green for what is active.

| Token                                            | Light                           | Dark                            |
| ------------------------------------------------ | ------------------------------- | ------------------------------- |
| `--mf-color-bg` · `--mf-color-surface`           | `#ECEAE2` · `#F0F0F0`           | `#0A0D0A` · `#121712`           |
| `--mf-color-text` · `--mf-color-text-secondary`  | `#333333` · `#666666`           | `#C8F5C8` · `#7FA37F`           |
| `--mf-color-border` · `--mf-color-border-strong` | `#CCCCCC` · `#333333`           | `#2E3A2E` · `#7FA37F`           |
| `--mf-color-primary` · `--mf-color-on-primary`   | `#00FF00` · `#1A1A1A`           | `#00FF00` · `#0A0D0A`           |
| `--mf-focus-ring`                                | 2 px `#333333` + 2 px `#00FF00` | 2 px `#00FF00` + 2 px `#0A0D0A` |

- The primary green is only ever a background behind dark text, about 11:1. As text or a border on the light theme
  it would be about 1.4:1, so it is never used that way there.
- Type: a pixel font, Departure Mono, for headings, labels, buttons and tabs; IBM Plex Sans for text; IBM Plex Mono
  for values, code and snapshot data. The pixel font is never used for running text.
- Spacing steps are 4, 8, 16, 24 and 32 px; radii 0, 2 and 4 px, and chips are pills; elevation has three levels
  of offset dithered shadow.
- Motion is short and stepwise, and off under `prefers-reduced-motion`.
- The theme follows `prefers-color-scheme` until the user picks one; `data-theme` on `<html>` holds it.
- Icons are pixelarticons.

Exact values are tuned in this package as screens are built; the names of the tokens are the contract.

### Components

`Window` (a titled panel), `Button`, `IconButton`, `Link`, `TextField`, `PasswordField`, `Select`, `Checkbox`,
`Tabs`, `Table` with sorting and a virtualized body, `Tree` for nested values, `Dialog`, `Menu`, `Toast`, `Alert`,
`Chip`, `Badge`, `EmptyState`, `Spinner`, `Tooltip`, `CopyField`, and the layout parts `Stack`, `Grid` and `Spacer`.
Each wraps a React Aria component, which gives it keyboard, focus and ARIA behavior, and is styled by a CSS Module.

## Layout

```text
packages/ui/src/
├── index.ts          the components and their types
├── tokens/           tokens.css with both themes, the token names in TypeScript, the contrast pairs
├── fonts/            Departure Mono and IBM Plex, with their OFL licences
├── icons/            the pixelarticons the hub uses
├── components/       one folder per component: <Name>.tsx and <Name>.module.css
└── layout/           Stack, Grid, Spacer
```

## Key flows

### Using the kit

1. The web app imports `@micafox/ui/tokens.css` once, then components from `@micafox/ui`.
2. Screens arrange components with `Stack` and `Grid` and never set a class or a style.
3. A new need is a new component or variant here, never CSS in a feature.

### Checking accessibility

1. A unit test computes the contrast of every text and border pair the tokens promise, in both themes, against
   WCAG 2.2 AA.
2. Component tests run axe and drive each component from the keyboard.

## Decisions

- [0034. Style the UI with CSS Modules, tokens and React Aria](../../adr/hub/ui/0034-style-the-ui-with-css-modules-tokens-and-react-aria.md)
- [0022. Split the hub into packages by role](../../adr/packages/0022-split-the-hub-into-packages-by-role.md)
