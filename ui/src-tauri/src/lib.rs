// RenzBase - one executable: the window, the injector and the payload.
//
// Injection happens inside this process. Module.dll is embedded into this
// binary at compile time (ui/src-tauri/assets/Module.dll, refreshed by the
// GitHub Actions build), written to %TEMP% on demand and loaded into
// RobloxPlayerBeta.exe with a remote LoadLibraryW. There is no Injector.exe
// and no Loader.exe any more: this exe is the loader.
//
// Scripts travel to the injected DLL over the named pipe \\.\pipe\RenzBase,
// as raw UTF-8 bytes, which is the protocol the DLL's pipe thread reads.

use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PIPE_NAME: &str = r"\\.\pipe\RenzBase";
const ROBLOX_EXE: &str = "RobloxPlayerBeta.exe";

/// The payload, baked into the exe.
const MODULE_DLL: &[u8] = include_bytes!("../assets/Module.dll");

static ATTACHED: AtomicBool = AtomicBool::new(false);
static ATTACHED_PID: AtomicU32 = AtomicU32::new(0);

type Handle = isize;
const INVALID_HANDLE: Handle = -1;

#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; 260],
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn VirtualAllocEx(process: Handle, address: *const c_void, size: usize, alloc_type: u32, protect: u32) -> *mut c_void;
    fn VirtualFreeEx(process: Handle, address: *mut c_void, size: usize, free_type: u32) -> i32;
    fn WriteProcessMemory(process: Handle, base: *mut c_void, buffer: *const c_void, size: usize, written: *mut usize) -> i32;
    fn CreateRemoteThread(process: Handle, attrs: *const c_void, stack: usize, start: *const c_void, param: *mut c_void, flags: u32, thread_id: *mut u32) -> Handle;
    fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
    fn GetExitCodeThread(thread: Handle, code: *mut u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *const c_void;
    fn GetTempPathW(length: u32, buffer: *mut u16) -> u32;
    fn CreateFileW(name: *const u16, access: u32, share: u32, attrs: *const c_void, disposition: u32, flags: u32, template: Handle) -> Handle;
    fn WriteFile(file: Handle, buffer: *const u8, length: u32, written: *mut u32, overlapped: *const c_void) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(window: Handle, operation: *const u16, file: *const u16, params: *const u16, directory: *const u16, show: i32) -> Handle;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error() -> String {
    std::io::Error::last_os_error().to_string()
}

// ---------------------------------------------------------------- processes

fn find_process(name: &str) -> Option<u32> {
    unsafe {
        // TH32CS_SNAPPROCESS
        let snapshot = CreateToolhelp32Snapshot(0x0000_0002, 0);
        if snapshot == INVALID_HANDLE || snapshot == 0 {
            return None;
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;

        let mut found = None;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let end = entry
                .sz_exe_file
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(entry.sz_exe_file.len());
            let exe = String::from_utf16_lossy(&entry.sz_exe_file[..end]);
            if exe.eq_ignore_ascii_case(name) {
                found = Some(entry.th32_process_id);
                break;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        found
    }
}

fn temp_dir() -> PathBuf {
    let mut buffer = vec![0u16; 512];
    unsafe {
        let length = GetTempPathW(buffer.len() as u32, buffer.as_mut_ptr());
        if length > 0 && (length as usize) < buffer.len() {
            let path = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
            if path.is_dir() {
                return path;
            }
        }
    }
    std::env::temp_dir()
}

/// Drop the embedded DLL on disk so the target process can load it from a path.
fn write_module_dll() -> Result<PathBuf, String> {
    let directory = temp_dir().join("RenzBase");
    fs::create_dir_all(&directory).map_err(|error| format!("create {}: {error}", directory.display()))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let path = directory.join(format!("Module_{stamp}.dll"));
    fs::write(&path, MODULE_DLL).map_err(|error| format!("write {}: {error}", path.display()))?;
    Ok(path)
}

fn inject_into(pid: u32, dll: &Path) -> Result<(), String> {
    // PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION
    // | PROCESS_VM_WRITE | PROCESS_VM_READ
    const ACCESS: u32 = 0x0002 | 0x0400 | 0x0008 | 0x0020 | 0x0010;
    const MEM_COMMIT_RESERVE: u32 = 0x1000 | 0x2000;
    const MEM_RELEASE: u32 = 0x8000;
    const PAGE_READWRITE: u32 = 0x04;

    unsafe {
        let process = OpenProcess(ACCESS, 0, pid);
        if process == 0 {
            return Err(format!(
                "could not open Roblox (pid {pid}): {}. Try running RenzBase as administrator.",
                last_error()
            ));
        }

        let path_w = wide(&dll.to_string_lossy());
        let size = path_w.len() * std::mem::size_of::<u16>();

        let remote = VirtualAllocEx(process, std::ptr::null(), size, MEM_COMMIT_RESERVE, PAGE_READWRITE);
        if remote.is_null() {
            CloseHandle(process);
            return Err(format!("VirtualAllocEx failed: {}", last_error()));
        }

        let mut written = 0usize;
        let copied = WriteProcessMemory(process, remote, path_w.as_ptr() as *const c_void, size, &mut written);
        if copied == 0 {
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
            return Err(format!("WriteProcessMemory failed: {}", last_error()));
        }

        let kernel_name = wide("kernel32.dll");
        let kernel = GetModuleHandleW(kernel_name.as_ptr());
        let load_library = GetProcAddress(kernel, b"LoadLibraryW\0".as_ptr());
        if load_library.is_null() {
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
            return Err("could not resolve LoadLibraryW".to_string());
        }

        let mut thread_id = 0u32;
        let thread = CreateRemoteThread(process, std::ptr::null(), 0, load_library, remote, 0, &mut thread_id);
        if thread == 0 {
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
            return Err(format!(
                "CreateRemoteThread failed: {}. If Roblox just opened, give it a few seconds and press Launch again.",
                last_error()
            ));
        }

        WaitForSingleObject(thread, 15_000);
        let mut exit_code = 0u32;
        GetExitCodeThread(thread, &mut exit_code);

        CloseHandle(thread);
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        CloseHandle(process);

        if exit_code == 0 {
            return Err("LoadLibraryW returned null: Module.dll did not load. Roblox's memory layout may have changed since the offsets were dumped (see scripts/update_offsets.py).".to_string());
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- commands

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub running: bool,
    pub pid: u32,
    pub attached: bool,
    pub payload_bytes: usize,
}

#[tauri::command]
fn client_status() -> ClientStatus {
    match find_process(ROBLOX_EXE) {
        Some(pid) => ClientStatus {
            running: true,
            pid,
            attached: ATTACHED.load(Ordering::SeqCst) && ATTACHED_PID.load(Ordering::SeqCst) == pid,
            payload_bytes: MODULE_DLL.len(),
        },
        None => {
            ATTACHED.store(false, Ordering::SeqCst);
            ATTACHED_PID.store(0, Ordering::SeqCst);
            ClientStatus {
                running: false,
                pid: 0,
                attached: false,
                payload_bytes: MODULE_DLL.len(),
            }
        }
    }
}

/// Inject the embedded Module.dll into the running Roblox client.
#[tauri::command]
fn inject() -> Result<ClientStatus, String> {
    let pid = find_process(ROBLOX_EXE)
        .ok_or_else(|| "Roblox is not running. Open Roblox, join a game, then press Launch.".to_string())?;
    let dll = write_module_dll()?;
    inject_into(pid, &dll)?;
    // The DLL starts its pipe thread during DllMain.
    std::thread::sleep(Duration::from_millis(700));
    ATTACHED.store(true, Ordering::SeqCst);
    ATTACHED_PID.store(pid, Ordering::SeqCst);
    Ok(client_status())
}

/// Send Luau source to the injected DLL over the named pipe.
#[tauri::command]
fn execute_script(script: String) -> Result<usize, String> {
    if script.trim().is_empty() {
        return Err("There is nothing to run.".to_string());
    }
    if !ATTACHED.load(Ordering::SeqCst) {
        return Err("Not attached. Press Launch first.".to_string());
    }

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;

    unsafe {
        let name = wide(PIPE_NAME);
        let handle = CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            0,
        );
        if handle == INVALID_HANDLE || handle == 0 {
            ATTACHED.store(false, Ordering::SeqCst);
            return Err(format!(
                "the RenzBase pipe is not there ({}). Press Launch again.",
                last_error()
            ));
        }

        let bytes = script.as_bytes();
        let mut written = 0u32;
        let ok = WriteFile(handle, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null());
        CloseHandle(handle);

        if ok == 0 {
            return Err(format!("WriteFile failed: {}", last_error()));
        }
        Ok(written as usize)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub name: String,
    pub path: String,
    pub folder: bool,
    pub children: Vec<ScriptEntry>,
}

fn scripts_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
    let directory = PathBuf::from(appdata).join("RenzBase").join("scripts");
    fs::create_dir_all(&directory).map_err(|error| format!("create {}: {error}", directory.display()))?;
    Ok(directory)
}

/// First-run folders, with the four starter slots the sidebar shows.
fn ensure_workspace() -> Result<PathBuf, String> {
    let directory = scripts_dir()?;
    for folder in ["Library", "AutoExecute"] {
        let _ = fs::create_dir_all(directory.join(folder));
    }

    let library = directory.join("Library");
    let empty = fs::read_dir(&library)
        .map(|entries| entries.flatten().count() == 0)
        .unwrap_or(true);
    if empty {
        let starters = [
            ("infinite-yield.lua", "Infinite Yield"),
            ("dex-explorer.lua", "Dex Explorer"),
            ("simple-spy.lua", "SimpleSpy"),
            ("hydroxide.lua", "Hydroxide"),
        ];
        for (file, label) in starters {
            let body = format!(
                "-- {label}\n-- Paste this script's loadstring here, then press Run.\n--\n-- Example shape:\n--   loadstring(game:HttpGet(\"<the script's raw url>\"))()\n"
            );
            let _ = fs::write(library.join(file), body);
        }
    }
    Ok(directory)
}

fn is_script(path: &Path) -> bool {
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => {
            let extension = extension.to_ascii_lowercase();
            extension == "lua" || extension == "luau" || extension == "txt"
        }
        None => false,
    }
}

fn read_tree(directory: &Path) -> Vec<ScriptEntry> {
    let mut files: Vec<ScriptEntry> = Vec::new();
    let mut folders: Vec<ScriptEntry> = Vec::new();

    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                folders.push(ScriptEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    folder: true,
                    children: read_tree(&path),
                });
            } else if is_script(&path) {
                files.push(ScriptEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    folder: false,
                    children: Vec::new(),
                });
            }
        }
    }

    let by_name = |left: &ScriptEntry, right: &ScriptEntry| {
        left.name.to_lowercase().cmp(&right.name.to_lowercase())
    };
    folders.sort_by(by_name);
    files.sort_by(by_name);
    folders.extend(files);
    folders
}

#[tauri::command]
fn list_scripts() -> Result<Vec<ScriptEntry>, String> {
    let directory = ensure_workspace()?;
    Ok(read_tree(&directory))
}

#[tauri::command]
fn read_script(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|error| format!("read {path}: {error}"))
}

/// Save into the workspace root; `name` may not contain path separators.
#[tauri::command]
fn save_script(name: String, content: String) -> Result<String, String> {
    let directory = scripts_dir()?;
    let mut clean = name.trim().to_string();
    if clean.is_empty() {
        clean = "untitled.lua".to_string();
    }
    if clean.contains("..") || clean.contains('/') || clean.contains('\\') || clean.contains(':') {
        return Err("a script name cannot contain a path".to_string());
    }
    if !clean.contains('.') {
        clean.push_str(".lua");
    }
    let path = directory.join(&clean);
    fs::write(&path, content).map_err(|error| format!("write {}: {error}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// Overwrite a script that already has a path, wherever it sits.
#[tauri::command]
fn save_to_path(path: String, content: String) -> Result<String, String> {
    fs::write(&path, content).map_err(|error| format!("write {path}: {error}"))?;
    Ok(path)
}

#[tauri::command]
fn workspace_path() -> Result<String, String> {
    Ok(ensure_workspace()?.to_string_lossy().to_string())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let target = wide(&path);
    let operation = wide("open");
    let result = unsafe {
        ShellExecuteW(0, operation.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), 1)
    };
    if result as isize <= 32 {
        return Err(format!("could not open {path}"));
    }
    Ok(())
}

/// Start the Roblox client app, without joining a game.
#[tauri::command]
fn launch_roblox() -> Result<String, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    let versions = PathBuf::from(local).join("Roblox").join("Versions");
    let mut newest: Option<(SystemTime, PathBuf)> = None;

    if let Ok(entries) = fs::read_dir(&versions) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(ROBLOX_EXE);
            if candidate.is_file() {
                let stamp = candidate
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .unwrap_or(UNIX_EPOCH);
                if newest.as_ref().map(|(mine, _)| stamp > *mine).unwrap_or(true) {
                    newest = Some((stamp, candidate));
                }
            }
        }
    }

    match newest {
        Some((_, path)) => {
            let target = wide(&path.to_string_lossy());
            let operation = wide("open");
            let result = unsafe {
                ShellExecuteW(0, operation.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), 1)
            };
            if result as isize <= 32 {
                return Err("Roblox would not start".to_string());
            }
            Ok(path.to_string_lossy().to_string())
        }
        None => Err("Roblox is not installed for this user".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            client_status,
            inject,
            execute_script,
            list_scripts,
            read_script,
            save_script,
            save_to_path,
            workspace_path,
            open_path,
            launch_roblox,
        ])
        .setup(|_app| {
            let _ = ensure_workspace();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("RenzBase failed to start");
}
