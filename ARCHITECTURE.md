# How RenzBase works

One process. The exe is the window, the injector and the payload.

## The pieces

### `RenzBase.exe`

A Tauri app. `ui/src` is the window (plain HTML, CSS and JS, no bundler, no CDN).
`ui/src-tauri/src/lib.rs` is everything else:

1. **Finds Roblox.** Walks the process list for `RobloxPlayerBeta.exe`.
2. **Writes the payload.** `Module.dll` is `include_bytes!`-ed into the binary at
   compile time, so there is no DLL to ship beside the exe. It is written to
   `%TEMP%\RenzBase\Module_<timestamp>.dll`.
3. **Loads it in Roblox.** `OpenProcess` → `VirtualAllocEx` → `WriteProcessMemory`
   → `CreateRemoteThread(LoadLibraryW)` → wait for the thread → check its exit
   code, which is the loaded module handle.
4. **Talks to it.** Scripts go over `\\.\pipe\RenzBase` as raw UTF-8 bytes.

### `Module.dll` (the payload)

Compiled from `dll/` by MSBuild, then baked into the exe. Once inside Roblox:

1. Finds the Lua state by reading the offsets in `dll/Source/Roblox/Offsets/`
   (`TaskScheduler` → `ScriptContext` → `main_thread`).
2. Registers the executor functions: `writefile`, `readfile`, `crypt.hash`,
   `firetouchinterest`, `identifyexecutor`, and the rest.
3. Runs a pipe thread: `CreateNamedPipeA("\\.\pipe\RenzBase")`, then
   `luaL_loadstring` + `luau_execute` on whatever arrives.

## The flow when you press Run

```
RenzBase.exe                 Module.dll (inside Roblox)
     │                                    │
     │  CreateFileW \\.\pipe\RenzBase     │
     │ ─────────────────────────────────► │
     │  WriteFile(lua source)             │
     │ ─────────────────────────────────► │
     │                          luaL_loadstring(src)
     │                          luau_execute(L)
     │                                    │
     │                          output → F9 console
```

## Why the offsets matter

Roblox moves functions around every update. The addresses live in
`dll/Source/Roblox/Offsets/Offsets.h` and were dumped for build
`e7d81637d42c4b23`. `scripts/update_offsets.py` refreshes them from a new dump.
Rebuilding the exe with the old offsets gives you a fresh binary that injects
into the wrong addresses, so a Roblox patch means: dump, refresh, rebuild.

## Hyperion

Roblox's anti-cheat sees `CreateRemoteThread` + `LoadLibraryW`. Public bypasses
(driver-level ones like Potassium) get detected within weeks, so this repo does
not bundle one. If a build injects and runs nothing, the offsets are the first
thing to check, not the loader.
