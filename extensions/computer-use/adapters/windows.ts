/** Shared Windows desktop backend for native Windows and WSL PowerShell interop. */
import { spawnSync } from "node:child_process";
import type {
	DoctorReport,
	FrontAppInfo,
	PlatformAdapter,
	PlatformCapabilities,
	Point,
	ScreenshotResult,
	WindowInfo,
} from "../platform";
import { stateHash } from "../gate";

const MAX_SCREENSHOT_WIDTH = 1280;
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 16 * 1024 * 1024;

interface PowerShellResponse {
	ok: boolean;
	message?: string;
	windows?: WindowInfo[];
	front?: FrontAppInfo | null;
	apps?: { name: string; bundleId: string; path: string }[];
	width?: number;
	height?: number;
	logicalWidth?: number;
	logicalHeight?: number;
	jpeg?: string;
	bgra?: string;
	psVersion?: string;
	windowCount?: number;
}

const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PiCuaWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static int ForegroundPid() {
    uint pid = 0; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return (int)pid;
  }
  public static int[] WindowBounds(IntPtr hwnd) {
    RECT r; if (!GetWindowRect(hwnd, out r)) return new int[] {0,0,0,0};
    return new int[] {r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top};
  }
  public static int SendUnicode(string text) {
    if (String.IsNullOrEmpty(text)) return 0;
    var input = new INPUT[text.Length*2];
    for (int i=0; i<text.Length; i++) {
      input[i*2].type=1; input[i*2].U.ki.wScan=text[i]; input[i*2].U.ki.dwFlags=0x0004;
      input[i*2+1].type=1; input[i*2+1].U.ki.wScan=text[i]; input[i*2+1].U.ki.dwFlags=0x0004|0x0002;
    }
    return (int)SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[void][PiCuaWin32]::SetProcessDPIAware()

function Write-Json($value) {
  [Console]::WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 10))
}
function Get-WindowRows {
  $frontPid = [PiCuaWin32]::ForegroundPid()
  $rows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
    $bounds = [PiCuaWin32]::WindowBounds($_.MainWindowHandle)
    if ($bounds[2] -gt 0 -and $bounds[3] -gt 0) {
      [PSCustomObject]@{
        pid=$_.Id; title=$_.MainWindowTitle; appName=$_.ProcessName;
        bounds=@{x=$bounds[0];y=$bounds[1];width=$bounds[2];height=$bounds[3]};
        isFocused=($_.Id -eq $frontPid)
      }
    }
  })
  return @{frontPid=$frontPid;windows=$rows}
}
function Escape-SendKeys([string]$value) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($char in $value.ToCharArray()) {
    $token = switch ([string]$char) {
      '+' { '{+}' } '^' { '{^}' } '%' { '{%}' } '~' { '{~}' }
      '(' { '{(}' } ')' { '{)}' } '[' { '{[}' } ']' { '{]}' }
      '{' { '{{}' } '}' { '{}}' }
      default { [string]$char }
    }
    [void]$builder.Append($token)
  }
  return $builder.ToString()
}
function Convert-KeyChord([string]$value) {
  $parts = $value -split '\+'
  if ($parts.Count -eq 0) { throw 'Key cannot be empty.' }
  $mods = ''
  for ($i=0; $i -lt ($parts.Count-1); $i++) {
    switch ($parts[$i].Trim().ToLowerInvariant()) {
      {$_ -in 'ctrl','control','cmd','command'} { $mods += '^' }
      'shift' { $mods += '+' }
      'alt' { $mods += '%' }
      'win' { throw 'Windows-key chords are not supported.' }
      default { throw ('Unknown key modifier: ' + $parts[$i]) }
    }
  }
  $key = $parts[$parts.Count-1].Trim().ToLowerInvariant()
  $named = @{
    enter='{ENTER}'; return='{ENTER}'; tab='{TAB}'; esc='{ESC}'; escape='{ESC}';
    backspace='{BACKSPACE}'; delete='{DELETE}'; del='{DELETE}'; space=' ';
    up='{UP}'; down='{DOWN}'; left='{LEFT}'; right='{RIGHT}'; home='{HOME}'; end='{END}';
    pageup='{PGUP}'; pagedown='{PGDN}'; insert='{INSERT}';
    f1='{F1}'; f2='{F2}'; f3='{F3}'; f4='{F4}'; f5='{F5}'; f6='{F6}';
    f7='{F7}'; f8='{F8}'; f9='{F9}'; f10='{F10}'; f11='{F11}'; f12='{F12}'
  }
  if ($named.ContainsKey($key)) { return $mods + $named[$key] }
  if ($key.Length -eq 1) { return $mods + (Escape-SendKeys $key) }
  throw ('Unsupported key: ' + $key)
}

switch ([string]$request.action) {
  'screenshot' {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($screen.Width -le 0 -or $screen.Height -le 0) { throw 'Primary display has no captureable bounds.' }
    $raw = New-Object System.Drawing.Bitmap($screen.Width,$screen.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($raw)
    try {
      $graphics.CopyFromScreen($screen.Left,$screen.Top,0,0,$raw.Size)
      $scale = [Math]::Min(1.0, 1280.0 / $raw.Width)
      $outWidth = [Math]::Max(1,[int][Math]::Round($raw.Width*$scale))
      $outHeight = [Math]::Max(1,[int][Math]::Round($raw.Height*$scale))
      $scaled = New-Object System.Drawing.Bitmap($outWidth,$outHeight,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
      try {
        $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaledGraphics.DrawImage($raw,0,0,$outWidth,$outHeight)
        $stream = New-Object System.IO.MemoryStream
        try {
          $scaled.Save($stream,[System.Drawing.Imaging.ImageFormat]::Jpeg)
          $jpeg = [Convert]::ToBase64String($stream.ToArray())
        } finally { $stream.Dispose() }
        $rect = New-Object System.Drawing.Rectangle(0,0,$scaled.Width,$scaled.Height)
        $bits = $scaled.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
          $bgraBytes = New-Object byte[] ([Math]::Abs($bits.Stride)*$scaled.Height)
          [Runtime.InteropServices.Marshal]::Copy($bits.Scan0,$bgraBytes,0,$bgraBytes.Length)
          $bgra = [Convert]::ToBase64String($bgraBytes)
        } finally { $scaled.UnlockBits($bits) }
        Write-Json @{ok=$true;width=$outWidth;height=$outHeight;logicalWidth=$screen.Width;logicalHeight=$screen.Height;jpeg=$jpeg;bgra=$bgra}
      } finally { $scaledGraphics.Dispose(); $scaled.Dispose() }
    } finally { $graphics.Dispose(); $raw.Dispose() }
  }
  'windows' {
    $result = Get-WindowRows
    Write-Json @{ok=$true;front=$result.frontPid;windows=$result.windows}
  }
  'front' {
    $pid = [PiCuaWin32]::ForegroundPid()
    $proc = if ($pid -gt 0) { Get-Process -Id $pid -ErrorAction SilentlyContinue } else { $null }
    if ($proc) { Write-Json @{ok=$true;front=@{pid=$proc.Id;appName=$proc.ProcessName;bundleId=$proc.ProcessName}} }
    else { Write-Json @{ok=$true;front=$null} }
  }
  'apps' {
    $apps = @()
    try {
      $apps = @(Get-StartApps | Sort-Object Name | ForEach-Object { @{name=$_.Name;bundleId=$_.AppID;path=$_.AppID} })
    } catch { $apps = @() }
    Write-Json @{ok=$true;apps=$apps}
  }
  'activate' {
    $target = ([string]$request.target).Trim()
    if (-not $target) { throw 'activateApp requires an app name, title, or AppID.' }
    $findWindow = {
      Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($_.ProcessName -ieq $target -or $_.MainWindowTitle -like ('*' + $target + '*')) } | Select-Object -First 1
    }
    $proc = & $findWindow
    if (-not $proc) {
      $app = $null
      try { $app = Get-StartApps | Where-Object { $_.Name -like ('*' + $target + '*') -or $_.AppID -like ('*' + $target + '*') } | Select-Object -First 1 } catch { }
      if ($app) { Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $app.AppID) }
      else { Start-Process -FilePath $target }
      for ($i=0; $i -lt 20 -and -not $proc; $i++) { Start-Sleep -Milliseconds 250; $proc = & $findWindow }
    }
    if (-not $proc) { throw ('No visible window appeared for: ' + $target) }
    [void][PiCuaWin32]::ShowWindow($proc.MainWindowHandle,9)
    [void][PiCuaWin32]::SetForegroundWindow($proc.MainWindowHandle)
    Write-Json @{ok=$true;message=('Activated ' + $proc.ProcessName + ': ' + $proc.MainWindowTitle)}
  }
  'click' {
    [void][PiCuaWin32]::SetCursorPos([int]$request.x,[int]$request.y)
    $down = if ($request.button -eq 'right') { 0x0008 } else { 0x0002 }
    $up = if ($request.button -eq 'right') { 0x0010 } else { 0x0004 }
    [PiCuaWin32]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
    [PiCuaWin32]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
    if ($request.double) { Start-Sleep -Milliseconds 75; [PiCuaWin32]::mouse_event($down,0,0,0,[UIntPtr]::Zero); [PiCuaWin32]::mouse_event($up,0,0,0,[UIntPtr]::Zero) }
    Write-Json @{ok=$true;message='click sent'}
  }
  'type' {
    $sent = [PiCuaWin32]::SendUnicode([string]$request.text)
    if ($sent -ne ([string]$request.text).Length*2) { throw ('SendInput posted ' + $sent + ' of ' + (([string]$request.text).Length*2) + ' keyboard events.') }
    Write-Json @{ok=$true;message=('typed ' + ([string]$request.text).Length + ' characters')}
  }
  'key' {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait((Convert-KeyChord ([string]$request.key)))
    Write-Json @{ok=$true;message=('sent key ' + $request.key)}
  }
  'scroll' {
    if ($request.at) { [void][PiCuaWin32]::SetCursorPos([int]$request.at.x,[int]$request.at.y) }
    $ticks = [Math]::Max(1,[Math]::Min(20,[Math]::Abs([int]$request.amount)))
    $delta = if ($request.direction -eq 'up') { 120*$ticks } else { -120*$ticks }
    [PiCuaWin32]::mouse_event(0x0800,0,0,$delta,[UIntPtr]::Zero)
    Write-Json @{ok=$true;message=('scrolled ' + $request.direction + ' ' + $ticks)}
  }
  'doctor' {
    Add-Type -AssemblyName System.Windows.Forms
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $ps = $PSVersionTable.PSVersion.ToString()
    $windowCount = @((Get-WindowRows).windows).Count
    Write-Json @{ok=$true;width=$bounds.Width;height=$bounds.Height;psVersion=$ps;windowCount=$windowCount}
  }
  default { throw ('Unknown action: ' + $request.action) }
}
`;

function runPowerShell(request: Record<string, unknown>): PowerShellResponse {
	const encodedScript = Buffer.from(POWERSHELL, "utf16le").toString("base64");
	const isWsl = process.platform === "linux";
	const result = spawnSync(
		"powershell.exe",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript],
		{
			input: JSON.stringify(request),
			encoding: "utf8",
			timeout: TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
			...(isWsl ? { cwd: "/mnt/c" } : {}),
		},
	);
	if (result.error) {
		if (isWsl && "code" in result.error && result.error.code === "ENOENT") {
			throw new Error("Could not launch powershell.exe. Check that WSL interop is enabled and Windows System32 is on PATH.");
		}
		throw new Error(`PowerShell launch failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim().slice(-1500);
		throw new Error(`PowerShell exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
	}
	const lines = (result.stdout || "").split(/\r?\n/);
	const jsonLine = [...lines].reverse().find((line) => line.trimStart().startsWith("{"));
	if (!jsonLine) throw new Error(`PowerShell returned no JSON result: ${(result.stdout || "").trim().slice(-1000)}`);
	let response: PowerShellResponse;
	try {
		response = JSON.parse(jsonLine) as PowerShellResponse;
	} catch {
		throw new Error(`Could not parse Windows backend response: ${jsonLine.slice(0, 500)}`);
	}
	if (!response.ok) throw new Error(response.message || "Windows desktop action failed.");
	return response;
}

export function createWindowsAdapter(platform: "wsl" | "win32"): PlatformAdapter {
	let lastRaster = { width: 0, height: 0 };
	let lastLogical = { width: 0, height: 0 };
	const capabilities: PlatformCapabilities = {
		platform,
		screenshot: true,
		mouseKeyboard: true,
		a11y: false,
		clipboard: false,
		notes: [
			"Primary display only; accessibility tree is unavailable, so screenshots are required for visual observations.",
			"UAC secure desktop and some elevated applications cannot be controlled from a non-elevated Pi process.",
		],
	};

	return {
		capabilities,

		async frontmostApp(): Promise<FrontAppInfo | null> {
			return runPowerShell({ action: "front" }).front ?? null;
		},

		async activateApp(target: string): Promise<void> {
			runPowerShell({ action: "activate", target });
		},

		async listApps() {
			return runPowerShell({ action: "apps" }).apps ?? [];
		},

		async screenSize() {
			return { raster: { ...lastRaster }, logical: { ...lastLogical } };
		},

		async screenshot(): Promise<ScreenshotResult> {
			const response = runPowerShell({ action: "screenshot" });
			if (!response.width || !response.height || !response.logicalWidth || !response.logicalHeight || !response.jpeg || !response.bgra) {
				throw new Error("Windows screenshot response was incomplete.");
			}
			const bgra = Buffer.from(response.bgra, "base64");
			const rgba = Buffer.allocUnsafe(response.width * response.height * 4);
			for (let i = 0; i < response.width * response.height; i++) {
				rgba[i * 4] = bgra[i * 4 + 2];
				rgba[i * 4 + 1] = bgra[i * 4 + 1];
				rgba[i * 4 + 2] = bgra[i * 4];
				rgba[i * 4 + 3] = bgra[i * 4 + 3];
			}
			const jpeg = Buffer.from(response.jpeg, "base64");
			lastRaster = { width: response.width, height: response.height };
			lastLogical = { width: response.logicalWidth, height: response.logicalHeight };
			return {
				width: response.width,
				height: response.height,
				jpeg,
				hash: stateHash(rgba, response.width, response.height),
			};
		},

		async listWindows(): Promise<WindowInfo[]> {
			return runPowerShell({ action: "windows" }).windows ?? [];
		},

		async moveAndClick(point: Point, button: "left" | "right", double?: boolean): Promise<void> {
			runPowerShell({ action: "click", x: Math.round(point.x), y: Math.round(point.y), button, double: Boolean(double) });
		},

		async typeText(text: string): Promise<void> {
			runPowerShell({ action: "type", text });
		},

		async pressKey(combo: string): Promise<void> {
			runPowerShell({ action: "key", key: combo });
		},

		async scroll(direction: "up" | "down", amount: number, at?: Point): Promise<void> {
			runPowerShell({ action: "scroll", direction, amount, at: at ? { x: Math.round(at.x), y: Math.round(at.y) } : undefined });
		},

		async doctor(): Promise<DoctorReport> {
			const items: DoctorReport["items"] = [];
			try {
				const response = runPowerShell({ action: "doctor" });
				items.push({ ok: true, label: "PowerShell interop", detail: `Windows PowerShell ${response.psVersion ?? "available"}` });
				items.push({ ok: true, label: "Primary display capture", detail: `${response.width}x${response.height}` });
				items.push({ ok: true, label: "Visible windows", detail: `${response.windowCount ?? 0} found` });
				items.push({ ok: true, label: "Mouse/keyboard injection", detail: "user32 SendInput available (not exercised by doctor)" });
			} catch (error) {
				items.push({
					ok: false,
					label: "Windows desktop backend",
					detail: error instanceof Error ? error.message : String(error),
					fix: platform === "wsl" ? "Enable WSL interop and ensure powershell.exe is on PATH; restart Pi after changing WSL settings." : "Verify Windows PowerShell and desktop-session access.",
				});
			}
			items.push({ ok: false, label: "Accessibility tree", detail: "not implemented; visual screenshot observations are used" });
			return { items };
		},
	};
}
