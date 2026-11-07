// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, openOverlay, notify, appHome } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// Markdown files render formatted in the preview instead of as source.
const MARKDOWN = /\.(md|mdx|markdown)$/i;
const prose = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
// Images render in the preview: image() reads the app home, so each is copied there.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const IMAGE_DIR = "files-preview";
const IMAGE_MAX = 24 * 1024 * 1024;
// exec's output is capped at 8 MiB; base64 adds a third, so keep raw bytes well under.
const IMAGE_REMOTE_MAX = 5 * 1024 * 1024;
// A PowerShell single-quoted literal; typographic single quotes end it too.
const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, (c) => c + c)}'`;
const imageName = (path) => {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    // Image copies exist only for the preview: start each run with an empty cache.
    cx.spawn(async () => {
      const dir = `${appHome()}/${IMAGE_DIR}`;
      for (const f of await fs.readdir(dir).catch(() => [])) await fs.unlink(`${dir}/${f}`).catch(() => {});
    });
    // The Markdown Browser mod draws the right-click menu; without it, say so instead.
    this.hasMarkdownBrowser = false;
    cx.spawn(async cx => {
      this.hasMarkdownBrowser = await fs.access(`${appHome()}/mods/markdown-browser/mod.json`).then(() => true, () => false);
      cx.notify();
    });
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const changed = await watchFolder(root);
          if (!this.current(context)) continue;
          this.refresh(cx);
          // Keep an open Markdown file or image current.
          if (this.file && (this.isMarkdown || this.isImage) && changed.some(p => p === `${root}/${this.file}` || p === root)) this.show(this.file, cx);
        }
      } catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    // A reload of the same file keeps what it showed until the new content is read.
    const same = path === this.file;
    this.code?.release(); this.code = null; if (!same) { this.text = null; this.imagePath = null; }
    this.file = path; this.fileError = null;
    this.isMarkdown = Boolean(path && MARKDOWN.test(path));
    this.isImage = Boolean(path && IMAGE.test(path));
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    if (this.isImage) return this.showImage(path, context, root, on, cx);
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (this.isMarkdown) { this.text = value; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // image() reads only the app home: copy the file there, replacing this image's last copy.
  // Another machine's image comes over exec as base64 (its bytes never reach readTextFile).
  showImage(path, context, root, on, cx) {
    const request = (this.imageRequest = (this.imageRequest ?? 0) + 1);
    const full = `${root}/${path}`;
    cx.spawn(async cx => {
      try {
        let bytes;
        if (on) {
          // A size check first: base64 of a huge file would cross the connection only to be dropped.
          const wc = await exec("wc", ["-c", full], { on }).catch(() => null);
          if (wc?.code === 0 && Number(wc.stdout.trim()) > IMAGE_REMOTE_MAX) { this.fileError = "Image too large to preview"; return; }
          // -i differs between macOS and Linux, so the file comes in on stdin.
          let r = await exec("sh", ["-c", 'base64 < "$1"', "image", full], { on }).catch(() => null);
          if (!r || r.code !== 0) {
            // Windows: no base64 command.
            r = await exec("powershell", ["-NoProfile", "-Command",
              `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(full)}))`], { on }).catch(() => null);
          }
          if (!r || r.code !== 0) throw new Error("Cannot read the image");
          bytes = Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
          if (bytes.length > IMAGE_REMOTE_MAX) { this.fileError = "Image too large to preview"; return; }
        } else {
          bytes = await fs.readFile(full);
          if (bytes.length > IMAGE_MAX) { this.fileError = "Image too large to preview"; return; }
        }
        if (request !== this.imageRequest || this.file !== path) return;
        const dir = `${appHome()}/${IMAGE_DIR}`;
        await fs.mkdir(dir, { recursive: true });
        const prefix = imageName(`${on ?? ""}:${full}`);
        for (const f of await fs.readdir(dir).catch(() => [])) if (f.startsWith(`${prefix}-`)) await fs.unlink(`${dir}/${f}`).catch(() => {});
        const ext = (path.match(/\.[a-z0-9]+$/i) ?? [""])[0].toLowerCase();
        const name = `${prefix}-${Date.now().toString(36)}${ext}`;
        await fs.writeFile(`${dir}/${name}`, bytes);
        if (request !== this.imageRequest || this.file !== path) return;
        this.imagePath = `${IMAGE_DIR}/${name}`;
      } catch { if (request === this.imageRequest && this.file === path) this.fileError = "Cannot preview this image"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .when(!entry.dir && MARKDOWN.test(entry.name), el => el.on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          if (!this.hasMarkdownBrowser) {
            notify({ title: "Markdown Browser is not installed", body: "Add herdr.dev/mods/ohneda/herdr-markdown-browser for this menu.", level: "info" });
            return;
          }
          // 220 wide; 12 + 32 per item tall: Preview in new pane, Open in Default app.
          openOverlay({ mod: "markdown-browser", kind: "popup", width: 220, height: 12 + 32 * 2, props: { file: `${this.root}/${path}`, on: this.on } });
        }))
        .child(entry.dir ? svg(`mods/files-markdown/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-markdown/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(
        this.fileError ? div().p(12).text_color(t.dim).child(this.fileError)
          : this.isImage && this.imagePath ? div().flex_1().min_h(0).p(10).flex().items_center().justify_center()
            .child(image(this.imagePath).max_w_full().max_h_full())
            : this.isMarkdown && this.text !== null ? div().flex_1().min_h(0).px(14).py(10).text_size(13)
              .child(TextView.markdown(`files-md-${this.file}`, prose(this.text)).scrollable(true).selectable(true).size_full())
              : this.code ? Editor.new(this.code).flex_1().min_h(0)
                : div().p(12).text_color(t.dim).child("Loading file…")));
  }
}
