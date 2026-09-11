# DSH File Drop Attachments

A persistent DSH Web plugin that keeps native image previews and renders non-image drops as file attachments.

## Features

- PNG, JPG, JPEG, WebP, and GIF files stay in the native image preview rail.
- Missing image MIME types are recovered from the file extension.
- Other dragged or pasted files are rendered as compact attachment cards with filename, extension, vector type icon, and remove action.
- When the browser hides the source path, the Host matches a unique workspace file by name, size, and SHA-256 content before using its real path.
- Files outside the workspace fall back to a local copy under `~/.dsh/file-drop-attachments/` and are explicitly marked `副本` in the card and `[附件副本]` in model text.
- Fallback uploads are same-origin, filename-sanitized, session-isolated, and limited to 64 MiB per file.
- Draft attachments are retained per session while switching conversations.
- Historical durable image refs are sent as an extension-bearing cache alias under `%DSH_HOME%\file-drop-attachments\image-cache\...` instead of repeated image bytes; the alias is a hard link to `%DSH_HOME%\attachments\v1\objects\...` when supported, and images in the unresolved current request suffix remain native image content.
- The plugin is mounted by the profile startup composition.

## Compatibility

Verified against both client-runtime generations:

- DSH `0.1.0-rc.6` (web profile): the composer was a `<textarea>` inside `[data-input-scroll]`.
- DSH `0.1.2-rc.1` (desktop profile): the composer is a contenteditable Lexical editor inside the same region, and the send affordance is the primary-action button. Opening a card uses `remote.session.openWorkspacePath`, falling back to the older `workspaces.openPath`.

`sessionId` is a standard prop of session-scoped slots in both generations — `dsh-client-web-react` set it explicitly in 0.1.0, and `dsh-client-ui-session`'s builtin source provides `props: ["sessionId"]` in 0.1.2. The plugin also passes it through its own `inject(sessionId)`, which spreads the same value and survives a runtime that stops providing it.

### IME discipline

`inputActions.setDraft` is not a text edit: the host clears the draft, rebuilds it, and parks the caret at the end. Running that rewrite during an IME composition commits the pre-edit text and selects it, so the next keystroke replaces the character the user just typed. Every plugin-owned draft write therefore goes through the composition gate:

- `whenIdle` for bookkeeping writes (the sentinel that keeps the send affordance live).
- `whenSettled` for the submit-time write, which also re-checks at fire time so a composition opening in between is never written into.
- Enter during a composition is never claimed: the plugin declines the key and leaves the candidate window to the IME.
- `Cmd/Ctrl+Enter` keeps the composer's own submit mode; the plugin only folds the attachment lines in and lets the composer send.

## Install

The repository ships the prebuilt client bundle, so a GitHub source install is enough. One command installs the plugin and mounts it into the profile:

```bash
dsh plugin --profile web add github:dsh-plugins/dsh-file-drop-attachments
```

The command forwards to pnpm inside the profile directory and then reconciles `dsh.profile.bundles` against the installed state. This package declares `dsh.bundle.patch` (`cordis.patch.yml`), so the resolved dependency joins the bundle stack and the profile boot mounts it — no profile file is edited by hand. Restart DSH Web afterwards so the Host and Client plugin graph is rebuilt.

To install a local checkout while developing:

```bash
git clone https://github.com/dsh-plugins/dsh-file-drop-attachments.git
dsh plugin --profile web add file:./dsh-file-drop-attachments
```

To remove it:

```bash
dsh plugin --profile web remove dsh-file-drop-attachments-persisted
```

### Migrating a hand-mounted profile

Earlier revisions were mounted by hand: a `link:` dependency in the web profile plus a `file-drop-attachments` insert row in the profile's own `cordis.patch.yml`. Delete that insert row, then switch to the bundle channel — with the manual row still present the plugin mounts twice (two Host halves, two composer rails):

```bash
dsh plugin --profile web remove dsh-file-drop-attachments-persisted
dsh plugin --profile web add github:dsh-plugins/dsh-file-drop-attachments
```

### Offline install

For a machine without git access, unpack the repository anywhere and run the bundled installer. It copies the files under `$DSH_HOME/plugins`, links that copy from the web profile, registers it in `dsh.profile.bundles`, drops a legacy hand-written mount row if one is present, and then runs the profile's package manager:

```powershell
powershell -ExecutionPolicy Bypass -File ./install.ps1
```

Restart DSH Web afterwards, exactly as with the `dsh plugin` path.

## License

GPL-3.0-only. See `LICENSE`.
