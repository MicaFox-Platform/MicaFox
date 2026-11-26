# @micafox/configs

## 0.2.0

### Minor Changes

- [#117](https://github.com/MicaFox-Platform/MicaFox/pull/117) [`abf3ff1`](https://github.com/MicaFox-Platform/MicaFox/commit/abf3ff14f515ae5f5b3661045875868854dab05c) Thanks [@artem-horovyi](https://github.com/artem-horovyi)! - Support React in `.tsx`: the ESLint preset lints `.tsx` with type information, the rules of hooks and PascalCase components; the Vitest preset runs `*.test.tsx`; the new `tsconfig/workspace-react.json` compiles JSX, and `@micafox/configs/css-modules` types `*.module.css` imports.

- [#124](https://github.com/MicaFox-Platform/MicaFox/pull/124) [`f018a07`](https://github.com/MicaFox-Platform/MicaFox/commit/f018a0726e1f0b586c0262ce8653e9d63bda692a) Thanks [@artem-horovyi](https://github.com/artem-horovyi)! - `createVitestConfig()` takes `conditions`: more export conditions, such as a build variant's, resolved after `sourceCondition` and before Vite's defaults.

## 0.1.1

### Patch Changes

- [#107](https://github.com/MicaFox-Platform/MicaFox/pull/107) [`2e70335`](https://github.com/MicaFox-Platform/MicaFox/commit/2e703352a29144fe9bed95354247c005f79c0c60) Thanks [@artem-horovyi](https://github.com/artem-horovyi)! - No code changes: published through npm trusted publishing (OIDC)

## 0.1.0

### Minor Changes

- [#99](https://github.com/MicaFox-Platform/MicaFox/pull/99) [`661ddff`](https://github.com/MicaFox-Platform/MicaFox/commit/661ddffece4530c33f1d34a599cdec1ab72f449b) Thanks [@artem-horovyi](https://github.com/artem-horovyi)! - Initial release
