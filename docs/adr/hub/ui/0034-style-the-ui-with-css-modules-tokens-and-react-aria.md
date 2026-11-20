# 0034. Style the UI with CSS Modules, tokens and React Aria

## Status

Accepted · 2026-11-20

## Context

The hub has a distinctive retro look that every screen of every feature and of `ee/` must share, in a light and a
dark theme. Features must not bring styles of their own. Accessibility is a requirement: keyboard, focus and screen
readers for menus, dialogs, tables and trees. The CSP allows no inline scripts.

## Decision

We style `@micafox/ui` with CSS Modules and design tokens as CSS custom properties, build its components on React
Aria Components for behavior and accessibility, and allow no CSS, `className` or `style` outside the package.

## Alternatives

- **Tailwind with shadcn/ui on Radix** — fast to start, but utility classes in feature code are styles of their own,
  copied components drift apart, and Radix is maintained more slowly.
- **A component library such as Mantine or MUI** — fastest, but it looks like the library, the bundle is heavier,
  and the retro look fights its theme.
- **CSS-in-JS at run time** — costs at render time and needs CSP exceptions.

## Consequences

- Themes switch by `data-theme` without re-rendering; the token names are the contract, their values can be tuned.
- React Aria brings keyboard, focus and ARIA behavior, so the kit builds only the look.
- Every visual need is a component or variant in the kit; ESLint stops styles elsewhere.
