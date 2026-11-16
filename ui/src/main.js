// RenzBase - frontend. Talks to the Rust side through window.__TAURI__.core.invoke.
//
// Backend commands: client_status, inject, execute_script, list_scripts,
// read_script, save_script, save_to_path, workspace_path, open_path,
// launch_roblox.

const invoke = window.__TAURI__.core.invoke;

const state = {
  tabs: [{ id: "home", kind: "home", title: "Home", closable: false }],
  activeId: "home",
  nextId: 1,
  scripts: [],
  filter: "",
  log: [],
  status: { running: false, pid: 0, attached: false },
  workspace: "",
  settings: { autoExec: true },
  recent: [],
};

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------- utilities */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function baseName(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function loadprefs() {
  try {
    const saved = JSON.parse(localStorage.getItem("renzbase.prefs") || "{}");
    if (typeof saved.autoExec === "boolean") state.settings.autoExec = saved.autoExec;
    if (Array.isArray(saved.recent)) state.recent = saved.recent.slice(0, 6);
  } catch {
    /* first run */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      "renzbase.prefs",
      JSON.stringify({ autoExec: state.settings.autoExec, recent: state.recent.slice(0, 6) })
    );
  } catch {
    /* storage unavailable */
  }
}

function toast(message, level = "") {
  const node = document.createElement("div");
  node.className = `toast ${level}`;
  node.textContent = message;
  el("toasts").appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .2s ease";
    setTimeout(() => node.remove(), 220);
  }, level === "error" ? 6500 : 3800);
}

function logLine(message, level = "") {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  state.log.push({ stamp, message, level });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
  const body = el("console-body");
  if (!body) return;
  const line = document.createElement("div");
  line.className = `console-line ${level}`;
  line.innerHTML = `<span class="stamp">${stamp}</span>${escapeHtml(message)}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function setStatus(left, right) {
  if (left !== undefined) el("status-left").textContent = left;
  if (right !== undefined) el("status-right").textContent = right;
}

/* ------------------------------------------------------------------ tabs */

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeId) || state.tabs[0];
}

function openTab(tab) {
  const existing = state.tabs.find(
    (item) => item.id === tab.id || (item.kind === tab.kind && item.path && item.path === tab.path)
  );
  if (existing) {
    state.activeId = existing.id;
  } else {
    state.tabs.push(tab);
    state.activeId = tab.id;
  }
  render();
}

function newScriptTab() {
  const id = `t${state.nextId++}`;
  openTab({ id, kind: "script", title: `untitled-${state.nextId - 1}.lua`, path: null, content: "", dirty: false, closable: true });
  el("code")?.focus();
}

function closeTab(id) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  state.tabs.splice(index, 1);
  if (state.activeId === id) {
    state.activeId = state.tabs[Math.max(0, index - 1)]?.id || "home";
  }
  render();
}

function openFixed(kind, title) {
  openTab({ id: kind, kind, title, closable: false });
}

function markDirty(tab) {
  tab.dirty = true;
  renderTabs();
}

/* ------------------------------------------------------------------ tree */

function groupFromEntries() {
  const folders = state.scripts.filter((entry) => entry.folder);
  const rootFiles = state.scripts.filter((entry) => !entry.folder);
  const groups = [];

  const library = folders.find((entry) => entry.name.toLowerCase() === "library");
  groups.push({ name: "Library", entries: library ? library.children : [] });

  groups.push({ name: "Scripts", entries: rootFiles });

  for (const folder of folders) {
    if (folder.name.toLowerCase() === "library") continue;
    groups.push({ name: folder.name, entries: folder.children });
  }
  return groups;
}

function renderTree() {
  const tree = el("tree");
  if (!tree) return;
  const query = state.filter.trim().toLowerCase();
  const groups = groupFromEntries();
  tree.innerHTML = "";

  for (const group of groups) {
    const entries = query
      ? group.entries.filter((entry) => entry.name.toLowerCase().includes(query))
      : group.entries;

    if (query && entries.length === 0 && !group.name.toLowerCase().includes(query)) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "tree-group";

    const title = document.createElement("button");
    title.className = "tree-group-title";
    title.innerHTML = `<svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg><span>${escapeHtml(group.name)}</span>`;
    title.addEventListener("click", () => wrapper.classList.toggle("collapsed"));
    wrapper.appendChild(title);

    const items = document.createElement("div");
    items.className = "tree-items";

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = query ? "No match" : "No scripts yet";
      items.appendChild(empty);
    } else {
      for (const entry of entries) {
        const button = document.createElement("button");
        button.className = "tree-item";
        if (activeTab().path === entry.path) button.classList.add("is-active");
        button.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${escapeHtml(entry.name.replace(/\.(lua|luau|txt)$/i, ""))}</span>`;
        button.title = entry.path;
        button.addEventListener("click", () => openScript(entry));
        items.appendChild(button);
      }
    }

    wrapper.appendChild(items);
    tree.appendChild(wrapper);
  }
}

async function refreshTree() {
  try {
    state.scripts = await invoke("list_scripts");
  } catch (error) {
    state.scripts = [];
    logLine(`list_scripts: ${error}`, "error");
  }
  renderTree();
}

async function openScript(entry) {
  try {
    const content = await invoke("read_script", { path: entry.path });
    openTab({
      id: `t${state.nextId++}`,
      kind: "script",
      title: entry.name,
      path: entry.path,
      content,
      dirty: false,
      closable: true,
    });
    remember(entry.path);
  } catch (error) {
    toast(String(error), "error");
  }
}

function remember(path) {
  state.recent = [path, ...state.recent.filter((item) => item !== path)].slice(0, 6);
  savePrefs();
  if (activeTab().kind === "home") render();
}

/* ------------------------------------------------------------------ tabs render */

function renderTabs() {
  const host = el("tabs");
  host.innerHTML = "";
  for (const tab of state.tabs) {
    const node = document.createElement("div");
    node.className = `tab${tab.id === state.activeId ? " is-active" : ""}${tab.dirty ? " is-dirty" : ""}`;
    node.title = tab.path || tab.title;
    node.innerHTML = `<span class="tab-name">${escapeHtml(tab.title.replace(/\.(lua|luau)$/i, ""))}</span>`;
    node.addEventListener("click", () => {
      state.activeId = tab.id;
      render();
    });
    if (tab.closable) {
      const close = document.createElement("button");
      close.className = "tab-x";
      close.textContent = "×";
      close.setAttribute("aria-label", `Close ${tab.title}`);
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });
      node.appendChild(close);
    }
    host.appendChild(node);
  }
}

/* ------------------------------------------------------------------ views */

function homeView() {
  const { attached, running } = state.status;
  const statusText = attached ? "1 connected" : running ? "client found, not attached" : "no client";
  const recent = state.recent.length
    ? state.recent
        .map(
          (path) =>
            `<button class="row" data-open="${escapeHtml(path)}"><span class="row-name">${escapeHtml(baseName(path))}</span><span class="row-meta">recent</span></button>`
        )
        .join("")
    : `<div class="row-empty">Nothing opened yet</div>`;

  return `
    <div class="home">
      <div class="home-top">
        <div class="brand-big">
          <div class="mark">R</div>
          <h1>Welcome to RenzBase</h1>
        </div>
        <div class="status-card">
          <span class="dot" aria-hidden="true" style="width:7px;height:7px;border-radius:50%;background:${attached ? "var(--ok)" : "var(--dim)"}"></span>
          <div>
            <div class="label">CLIENT STATUS</div>
            <div class="value">${escapeHtml(statusText)}</div>
          </div>
        </div>
      </div>

      <div class="cards">
        <button class="card" data-action="new"><h2>New script</h2><p>Start with a blank file.</p><span class="glyph">{ }</span></button>
        <button class="card" data-action="library"><h2>Script Hub</h2><p>Browse the library folder.</p><span class="glyph">◇</span></button>
        <button class="card" data-action="launch"><h2>Launch Roblox</h2><p>Start the client, then attach.</p><span class="glyph">▸</span></button>
        <button class="card" data-action="settings"><h2>Settings</h2><p>Workspace and auto execute.</p><span class="glyph">◎</span></button>
      </div>

      <div class="home-lists">
        <div>
          <div class="list-title">QUICK ACTIONS</div>
          <button class="row" data-action="folder"><span class="row-name">Open scripts folder…</span><span class="row-meta">Ctrl+O</span></button>
          <button class="row" data-action="attach"><span class="row-name">Attach to Roblox</span><span class="row-meta">Launch</span></button>
        </div>
        <div>
          <div class="list-title">RECENT</div>
          ${recent}
        </div>
      </div>
    </div>
  `;
}

function editorView(tab) {
  const lines = tab.content.split("\n").length;
  const gutter = Array.from({ length: Math.max(lines, 1) }, (_, index) => index + 1).join("\n");
  const consoleHtml = state.log
    .map(
      (entry) =>
        `<div class="console-line ${entry.level}"><span class="stamp">${entry.stamp}</span>${escapeHtml(entry.message)}</div>`
    )
    .join("");

  return `
    <div class="editor">
      <div class="editor-body">
        <div class="gutter" id="gutter">${gutter}</div>
        <textarea id="code" class="code" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off">${escapeHtml(tab.content)}</textarea>
      </div>
      <div class="console">
        <div class="console-head"><span>CONSOLE</span></div>
        <div class="console-body" id="console-body">${consoleHtml}</div>
      </div>
    </div>
  `;
}

function libraryView() {
  const library = state.scripts.find((entry) => entry.folder && entry.name.toLowerCase() === "library");
  const entries = library ? library.children : [];
  const rows = entries.length
    ? entries
        .map(
          (entry) =>
            `<button class="row" data-open="${escapeHtml(entry.path)}"><span class="row-name">${escapeHtml(entry.name)}</span><span class="row-meta">open</span></button>`
        )
        .join("")
    : `<div class="row-empty">The Library folder is empty</div>`;

  return `
    <div class="page">
      <h1>Library</h1>
      <p class="sub">Files in <code>%APPDATA%\\RenzBase\\scripts\\Library</code>. Open one, paste its loadstring, press Run.</p>
      ${rows}
    </div>
  `;
}

function clientsView() {
  const { running, pid, attached, payloadBytes } = state.status;
  const statePill = attached
    ? `<span class="pill ok"><span class="dot" aria-hidden="true"></span>attached</span>`
    : running
      ? `<span class="pill bad"><span class="dot" aria-hidden="true"></span>not attached</span>`
      : `<span class="pill"><span class="dot" aria-hidden="true"></span>closed</span>`;

  return `
    <div class="page">
      <h1>Clients</h1>
      <p class="sub">One exe does everything: it holds the window, the injector and the payload.</p>
      <div class="setting">
        <div>
          <div class="setting-name">Roblox client</div>
          <div class="setting-note">${running ? `RobloxPlayerBeta.exe, pid ${pid}` : "Roblox is not running"}</div>
        </div>
        ${statePill}
      </div>
      <div class="setting">
        <div>
          <div class="setting-name">Embedded payload</div>
          <div class="setting-note">Module.dll inside this exe, ${(payloadBytes / 1024).toFixed(0)} KB</div>
        </div>
        <button class="tool" data-action="attach">Attach</button>
      </div>
      <div class="setting">
        <div>
          <div class="setting-name">Start Roblox</div>
          <div class="setting-note">Opens the client app; join a game, then attach.</div>
        </div>
        <button class="tool" data-action="launch">Launch Roblox</button>
      </div>
    </div>
  `;
}

function settingsView() {
  return `
    <div class="page">
      <h1>Settings</h1>
      <p class="sub">Stored on this PC, in <code>${escapeHtml(state.workspace || "%APPDATA%\\RenzBase\\scripts")}</code></p>
      <div class="setting">
        <div>
          <div class="setting-name">Run AutoExecute on attach</div>
          <div class="setting-note">Every .lua in the AutoExecute folder runs when the client attaches.</div>
        </div>
        <button class="switch${state.settings.autoExec ? " is-on" : ""}" data-action="toggle-autoexec" aria-pressed="${state.settings.autoExec}" aria-label="Run AutoExecute on attach"></button>
      </div>
      <div class="setting">
        <div>
          <div class="setting-name">Scripts folder</div>
          <div class="setting-note">${escapeHtml(state.workspace)}</div>
        </div>
        <button class="tool" data-action="folder">Open</button>
      </div>
      <div class="setting">
        <div>
          <div class="setting-name">RenzBase</div>
          <div class="setting-note">Single-executable build. Payload offsets come from dll/Source/Roblox/Offsets.</div>
        </div>
        <span class="pill">v0.2.0</span>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ render */

function render() {
  const tab = activeTab();
  renderTabs();

  const content = el("content");
  if (tab.kind === "home") content.innerHTML = homeView();
  else if (tab.kind === "library") content.innerHTML = libraryView();
  else if (tab.kind === "clients") content.innerHTML = clientsView();
  else if (tab.kind === "settings") content.innerHTML = settingsView();
  else content.innerHTML = editorView(tab);

  const code = el("code");
  if (code) {
    code.addEventListener("input", () => {
      tab.content = code.value;
      const gutter = el("gutter");
      const lines = code.value.split("\n").length;
      if (gutter) gutter.textContent = Array.from({ length: Math.max(lines, 1) }, (_, index) => index + 1).join("\n");
      if (!tab.dirty) markDirty(tab);
    });
    code.addEventListener("scroll", () => {
      const gutter = el("gutter");
      if (gutter) gutter.scrollTop = code.scrollTop;
    });
    code.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = code.selectionStart;
        code.setRangeText("    ", start, code.selectionEnd, "end");
        code.dispatchEvent(new Event("input"));
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        runActive();
      }
    });
    const body = el("console-body");
    if (body) body.scrollTop = body.scrollHeight;
  }

  for (const button of document.querySelectorAll(".rail-btn")) {
    button.classList.toggle("is-active", button.dataset.view === tab.kind);
  }

  renderTree();
  updateToolbar();
}

function updateToolbar() {
  const tab = activeTab();
  const isScript = tab.kind === "script";
  for (const id of ["run", "save", "copy", "clear-console"]) {
    const button = el(id);
    if (button) button.disabled = !isScript;
  }
  const attached = state.status.attached;
  el("launch").classList.toggle("is-attached", attached);
  el("clients").textContent = attached
    ? "1 connected"
    : state.status.running
      ? "client found"
      : "no client";
  setStatus(
    attached ? "attached" : state.status.running ? "client running, not attached" : "ready",
    state.workspace ? "RenzBase 0.2.0" : ""
  );
}

/* ------------------------------------------------------------------ actions */

async function refreshStatus() {
  try {
    state.status = await invoke("client_status");
  } catch {
    state.status = { running: false, pid: 0, attached: false, payloadBytes: 0 };
  }
  const signature = `${state.status.running}:${state.status.attached}:${state.status.pid}`;
  const changed = signature !== state.statusSignature;
  state.statusSignature = signature;
  updateToolbar();
  if (changed && (activeTab().kind === "home" || activeTab().kind === "clients")) {
    const content = el("content");
    if (content) {
      content.innerHTML = activeTab().kind === "home" ? homeView() : clientsView();
    }
  }
}

async function attach() {
  const button = el("launch");
  button.disabled = true;
  setStatus("attaching…");
  try {
    const status = await invoke("inject");
    state.status = status;
    toast("Attached. Press Run to execute.", "ok");
    logLine("attached to RobloxPlayerBeta.exe", "ok");
    if (state.settings.autoExec) await runAutoExecute();
  } catch (error) {
    toast(String(error), "error");
    logLine(String(error), "error");
  } finally {
    button.disabled = false;
    refreshStatus();
  }
}

async function runAutoExecute() {
  const folder = state.scripts.find((entry) => entry.folder && entry.name.toLowerCase() === "autoexecute");
  if (!folder || folder.children.length === 0) return;
  for (const entry of folder.children) {
    try {
      const content = await invoke("read_script", { path: entry.path });
      await invoke("execute_script", { script: content });
      logLine(`autoexec ${entry.name}`, "ok");
    } catch (error) {
      logLine(`autoexec ${entry.name}: ${error}`, "error");
    }
  }
}

async function runActive() {
  const tab = activeTab();
  if (tab.kind !== "script") return;
  try {
    const bytes = await invoke("execute_script", { script: tab.content });
    logLine(`ran ${tab.title} (${bytes} bytes)`, "ok");
    setStatus("script sent");
  } catch (error) {
    toast(String(error), "error");
    logLine(String(error), "error");
  }
}

async function saveActive() {
  const tab = activeTab();
  if (tab.kind !== "script") return;
  try {
    let path = tab.path;
    if (path) {
      await invoke("save_to_path", { path, content: tab.content });
    } else {
      let name = tab.title;
      try {
        const answer = window.prompt("Save as (name in the scripts folder):", tab.title);
        if (answer) name = answer;
      } catch {
        /* no prompt in this webview: fall back to the tab title */
      }
      path = await invoke("save_script", { name, content: tab.content });
      tab.path = path;
      tab.title = baseName(path);
      remember(path);
    }
    tab.dirty = false;
    toast(`Saved ${baseName(path)}`, "ok");
    await refreshTree();
    renderTabs();
  } catch (error) {
    toast(String(error), "error");
  }
}

async function copyActive() {
  const tab = activeTab();
  if (tab.kind !== "script") return;
  try {
    await navigator.clipboard.writeText(tab.content);
    toast("Copied to the clipboard", "ok");
  } catch {
    toast("The clipboard is not available", "error");
  }
}

async function openFolder() {
  try {
    await invoke("open_path", { path: state.workspace });
  } catch (error) {
    toast(String(error), "error");
  }
}

async function startRoblox() {
  try {
    await invoke("launch_roblox");
    toast("Roblox is starting. Join a game, then press Launch.", "ok");
    setTimeout(refreshStatus, 4000);
  } catch (error) {
    toast(String(error), "error");
  }
}

async function handleAction(action) {
  if (action === "new") newScriptTab();
  if (action === "library") openFixed("library", "Library");
  if (action === "settings") openFixed("settings", "Settings");
  if (action === "clients") openFixed("clients", "Clients");
  if (action === "attach") attach();
  if (action === "launch") startRoblox();
  if (action === "folder") openFolder();
  if (action === "toggle-autoexec") {
    state.settings.autoExec = !state.settings.autoExec;
    savePrefs();
    render();
  }
}

/* ------------------------------------------------------------------ wiring */

document.addEventListener("click", (event) => {
  const actionNode = event.target.closest("[data-action]");
  if (actionNode) {
    handleAction(actionNode.dataset.action);
    return;
  }
  const openNode = event.target.closest("[data-open]");
  if (openNode) {
    const path = openNode.dataset.open;
    const entry = { name: baseName(path), path };
    openScript(entry);
  }
});

for (const button of document.querySelectorAll(".rail-btn")) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view === "home") {
      state.activeId = "home";
      render();
    } else {
      openFixed(view, view.charAt(0).toUpperCase() + view.slice(1));
    }
  });
}

el("new-script").addEventListener("click", newScriptTab);
el("open-folder").addEventListener("click", openFolder);
el("launch").addEventListener("click", attach);
el("attach").addEventListener("click", attach);
el("run").addEventListener("click", runActive);
el("save").addEventListener("click", saveActive);
el("copy").addEventListener("click", copyActive);
el("snippets").addEventListener("click", () => handleAction("library"));
el("open-file").addEventListener("click", openFolder);
el("clear-console").addEventListener("click", () => {
  state.log = [];
  const body = el("console-body");
  if (body) body.innerHTML = "";
});
el("search").addEventListener("input", (event) => {
  state.filter = event.target.value;
  renderTree();
});

document.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier) return;
  if (event.key === "s") {
    event.preventDefault();
    saveActive();
  }
  if (event.key === "o") {
    event.preventDefault();
    openFolder();
  }
  if (event.key === "n" && event.shiftKey) {
    event.preventDefault();
    newScriptTab();
  }
});

/* ------------------------------------------------------------------ boot */

(async function boot() {
  loadprefs();
  try {
    state.workspace = await invoke("workspace_path");
  } catch {
    state.workspace = "%APPDATA%\\RenzBase\\scripts";
  }
  await refreshTree();
  await refreshStatus();
  render();
  setInterval(refreshStatus, 2500);
})();
