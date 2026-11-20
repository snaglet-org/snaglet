# @snaglet/ui

Shared visual foundation for Snaglet applications.

## Entry points

- `@snaglet/ui/styles` emits the runtime token and baseline CSS. Import it once from an application's `main.tsx`.
- `@snaglet/ui/abstracts` and its subpaths expose non-emitting Sass functions and mixins for CSS modules.
- `@snaglet/ui/sidebar-tree` exposes generic expandable sidebar primitives. They use grouped-action semantics because rows are ordinary buttons; the visual tree does not claim full ARIA tree keyboard behavior.
- `@snaglet/ui/leaf-toggle` exposes the shared leaf disclosure glyph.

## Boundaries

Shared components receive ordinary props and callbacks. They must not import desktop routing, Tauri, Snaglet APIs, workspace entities, or server code. Application adapters may layer those behaviors over the shared primitive, as desktop UI does for pane dragging.

Move a component here when at least two applications need the same behavior and appearance. Feature-specific components remain in their application.
