# app.js
A tiny reactive framework

# Overview

- Templates should be placed in /templates directory
- Meaningful attributes in templates are: data-component, data-show-if, data-value, data-on-*
- App needs to be constructed with parameters: element, data, methods and componentName, which is optional
- An App instance exposes `ready` — a promise that resolves when the initial mount finishes (and rejects with the original error if it fails)
- A template that fails to load (network error or HTTP error status) is not cached — the next load retries the fetch

# Development

The source of truth is `src/app.ts` (TypeScript). The root `app.js` and `app.d.ts` are build artifacts kept committed so a page can `import App from '/app.js'` with no build step — regenerate them with the build script, never edit them by hand.

```sh
npm ci            # install dev dependencies
npm run build     # compile src/app.ts → app.js + app.d.ts
npm test          # run the vitest suite
npm run typecheck
```

# Styling component wrappers

A `data-component` element is a real box in layout, which gets in the way inside flex or grid containers. Make a wrapper transparent to layout with:

```css
[data-component="widget"] {
    display: contents;
}
```

Two caveats: the wrapper's own background/border/padding stop rendering, and the rule should target specific components — the app stamps `data-component` on its root element (often `<body>`), which must keep its box.
