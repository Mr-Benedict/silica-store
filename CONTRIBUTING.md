# Contributing to the Silica Store

Thanks for wanting to add something. The bar is deliberately low on ceremony and high on honesty.

## Read this part first

**Everything in this catalog runs in other people's worlds.** A player who installs your entry is running
your code on their server, usually without reading it.

It runs inside Silica's sandbox — no host access, no file system beyond the scripts folder, no threads, no
network — and it runs behind whatever **server-wide capability doors** that particular server has left
open. Those doors are not per-app grants: if a server has `redstone` and `network` open, your script has
them, whatever your `silica.json` declared. The `needs` block is **disclosure so a player can decide**, not
a boundary that stops you.

So:

- **Nothing hostile.** No griefing, no wiping someone's storage, no draining their power, no spamming
  chat, no trying to escape the sandbox or exhaust the server.
- **Nothing deceptive.** The `title`, `summary` and `README.md` must describe what the code actually does.
  An entry whose behaviour is not the behaviour it advertises will be rejected or removed, including
  behaviour that only appears after a delay or on a condition.
- **Declare `needs` truthfully.** If your code touches `redstone`, say `redstone`. Understating the
  declaration to look harmless is the deceptive case above.
- **No obfuscation.** Source a reviewer cannot read will not be merged. That includes minified bundles and
  generated code with no readable source.

## The rules

### One folder per entry

```
scripts/<entry-id>/
  silica.json     required
  README.md       required — this is what the Store app shows a player
  ...             your code
```

The folder name **is** the entry id: lowercase letters, digits and hyphens, 1–48 characters, and
`silica.json`'s `"id"` must match it exactly. Pick something specific — `oak-farm-controller`, not
`farm`. Nothing goes in `scripts/` except entry folders.

- **`kind: "script"`** — exactly one `.js` file at the entry root, and no `ui/` directory.
- **`kind: "app"`** — an `entrypoint.js` or an `index.html` at the entry root, plus whatever else it
  needs (a `ui/` folder is the convention).

Field-by-field reference for `silica.json`, including what `doors`, `parts` and `mods` mean and the list of
valid categories, is in [README.md](README.md).

### Never edit `index.json`

CI generates it. A pull request that touches `index.json` will be asked to revert that file — its
timestamp and hashes come from the merge, not from your working tree. Your PR should contain only your
entry folder.

### Your README is the listing

It is rendered inside the Store app, so write it for a player who has not seen your code: what the entry
does, what hardware and blocks it needs, how to set it up, and which settings they are meant to change.

The renderer supports headings, paragraphs, bulleted and numbered lists, tables, fenced code blocks, and
inline `code`, `**bold**` and `*italic*`. Everything else — including raw HTML — renders as literal text.
**Images are not rendered**, and links appear as inert text rather than something clickable. Both are
deliberate: a remote image would be fetched by every viewer's game client, from a URL you control.

### Run the checks before you open the PR

```
node tools/build-index.mjs --check
```

Node 20 or newer, no dependencies. It prints every problem it finds, not just the first. CI runs exactly
this on your pull request.

It enforces:

1. every folder under `scripts/` has both `silica.json` and `README.md`;
2. `silica.json` is valid JSON; `id` equals the folder name and matches `[a-z0-9-]{1,48}`;
   `title`, `summary`, `kind`, `category` and `author` are present and non-empty; `summary` is a single
   line of at most 160 characters; `kind` is `script` or `app`; `category` is from the fixed list;
3. the shape the `kind` promises — one root `.js` and no `ui/` for a script, `entrypoint.js` or
   `index.html` for an app;
4. no symlinks; no dotfiles or dot-directories; no file over 262144 bytes; no entry with more than 64
   installable files; every entry-relative path at most 160 characters and 6 segments, with no `..`;
5. `needs.doors` drawn from `redstone`, `gfx`, `fs`, `network`, `pads`; `needs.parts` from `gpu`, `hdd`,
   `nic`; both optional, both arrays of strings when present.

Passing CI means your entry is **structurally** valid. It says nothing at all about whether the code is
good or safe.

### Review is manual

A human reads every submission before it merges — the code, not just the metadata. CI cannot tell a useful
script from a malicious one, so it does not try. Expect questions, and expect a review to take longer than
a green check does.

This repository's `main` branch is what most servers track, so a merge is a deploy. That is why the reading
is careful.

## Licensing

**Opening a pull request licenses your contribution under the MIT License** (see [LICENSE](LICENSE)), to
this project and to everyone who installs it.

This is not a formality. The whole premise of the Store is that an installed entry becomes ordinary
editable files in the player's own world — they can read it, change it, fix it and keep the result. A
contribution that cannot be copied and modified would break that, so only submit code you have the right
to license this way. Do not paste in someone else's work without permission and attribution.
