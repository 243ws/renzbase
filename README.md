# RenzBase

One executable. It holds the window, the injector and the payload.

No key system, no launcher, no separate DLL to keep next to the exe: `Module.dll`
is compiled from `dll/`, baked into the binary as bytes at build time, written to
`%TEMP%\RenzBase` on demand and loaded into `RobloxPlayerBeta.exe` with a remote
`LoadLibraryW`.

```
RenzBase.exe
├── ui/src            the window (Tauri: HTML + CSS + JS, no bundler)
├── ui/src-tauri      the app and the injector (Rust)
└── dll               the payload, embedded into the exe
```

## Run it

1. Open Roblox and join a game.
2. Start `RenzBase.exe`.
3. Press **Launch**. The status bar reads `1 connected`.
4. Type Luau in a tab, press **Run**.

Scripts live in `%APPDATA%\RenzBase\scripts`:

| Folder | What it holds |
|---|---|
| `Library` | Your saved scripts, shown under Library in the sidebar |
| `AutoExecute` | Every `.lua` here runs when the client attaches |
| root | Scripts created in the app |

## Build it yourself

GitHub builds it for you. Push to `main` (or press **Run workflow** on the
**Actions** tab), then download `RenzBase.exe` from the run's Artifacts:

```
msbuild dll\SkidBase.vcxproj -p:Configuration=Release -p:Platform=x64
copy dll\Release\Module.dll ui\src-tauri\assets\Module.dll
cd ui\src-tauri
cargo build --release --features custom-protocol
```

That is exactly what `.github/workflows/build.yml` does. The exe lands at
`ui/src-tauri/target/release/renzbase-ui.exe`; rename it to `RenzBase.exe`.
Windows needs the WebView2 runtime, which ships with Windows 10 and 11.

## When Roblox updates

A rebuild recompiles the same offsets, so it is not an update by itself. The
offsets in `dll/Source/Roblox/Offsets/` were dumped against Roblox build
`e7d81637d42c4b23`. After a Roblox patch:

1. Dump the new client and refresh the offsets (`scripts/update_offsets.py`).
2. Commit, let Actions rebuild, download the new exe.

Injection is a plain `CreateRemoteThread` + `LoadLibraryW`. Roblox's Hyperion
blocks some of those, which is why a fresh dump of the offsets is the part that
matters after each patch.

## Licence

MIT, see `LICENSE`. Portions derived from RavageDevs/SkidBase.
