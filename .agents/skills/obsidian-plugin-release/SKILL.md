---
name: obsidian-plugin-release
description: Maintain and release Obsidian community plugins using declarative settings on Obsidian 1.13+ and exact manifest-matching GitHub releases.
---

# Obsidian plugin maintenance and release

Use this skill when migrating an Obsidian plugin's settings UI or preparing a plugin release.

## Before editing

1. Inspect `manifest.json`, `package.json`, the lockfile, `versions.json`, version scripts, release workflows, and the current Git state.
2. Identify every existing setting key, default, validation rule, and runtime side effect before replacing the settings UI.
3. Confirm the repository's branch, remote, tag naming convention, and whether the release workflow creates drafts.
4. Do not assume the installed `obsidian` types expose the declarative API; inspect the dependency and update it only when the repository supports Obsidian 1.13+.

## Path A: clean Obsidian 1.13-only settings migration

Choose Path A only when dropping support for older Obsidian versions is intentional. Set:

```json
"minAppVersion": "1.13.0"
```

Update compatibility documentation as well.

Replace imperative settings construction (`display()`, `new Setting(...)`, and manual DOM controls) with the declarative `PluginSettingTab` API:

- Implement `getSettingDefinitions(): SettingDefinitionItem[]`.
- Bind each existing setting to its exact storage key using a declarative control.
- Preserve existing keys and defaults so stored user data remains compatible.
- Use `defaultValue` for controls where the API needs an explicit default.
- Represent reset buttons and similar operations as declarative action definitions rather than manually-created buttons.
- Import `SettingDefinitionItem` with `import type` when it is type-only.
- Keep application-specific side effects in `setControlValue()`; for example, reconfigure a client after URL/API-key changes.
- If linked controls affect each other, update the related setting values, persist them, and refresh the settings tab as needed.

Validate loaded data independently of the UI. Merge stored data over defaults, repair invalid types/ranges/enumerations, and persist repaired values with `saveData()` so bad data is not reintroduced on the next reload. Be careful with number controls: validate positive integer requirements explicitly rather than relying only on an HTML minimum.

After migration, search for and remove obsolete `display`, `Setting`, and unused `saveSettings` code, while retaining any shared persistence helper that is still referenced.

## Release checklist

1. Run the repository's available checks, normally:

   ```sh
   npm run lint
   npm run build
   npm test
   git diff --check
   ```

   Run `npm test` only when a test script is defined; otherwise skip it and report that clearly.
2. Bump the patch version through the repository's version script so `package.json`, `package-lock.json` when applicable, `manifest.json`, and `versions.json` stay synchronized.
3. Confirm the manifest version exactly matches the intended release version.
4. Commit, then create an annotated tag whose name is **exactly** the manifest version (for example `1.0.6`, not `v1.0.6`). Obsidian's release discovery can require this exact match even if a `v1.0.6` release also exists.
5. Push the release commit and exact tag.
6. Inspect the tag-triggered workflow with `gh run list`, wait with `gh run watch`, and verify the release with `gh release view`.
7. Every release made public must include a meaningful description/release notes. Summarize user-visible changes, compatibility requirements, and validation status; never publish a blank release description.
8. If the workflow creates a draft, publish it explicitly with the description:

   ```sh
   gh release edit <version> --draft=false --title "Plugin <version>" --notes "<release description>"
   ```

   This publishes the release and is an intentional remote mutation; do it only when publication is requested.

9. Final verification should confirm:
   - the release exists under the exact manifest version;
   - it is published, not draft or prerelease;
   - `main.js`, `manifest.json`, and `styles.css` (when present) are attached;
   - the exact tag points to the release commit;
   - the working tree is clean.

Never delete or replace an existing `v`-prefixed release solely to fix discovery. Add the exact manifest-matching tag/release on the same release commit when needed.
