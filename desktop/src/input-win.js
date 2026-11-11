// Mouse + keyboard control on Windows, used by Full Auto mode.
// One long-lived PowerShell process calls the Win32 SendInput API — no native Node modules needed.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FreedomInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);

  static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static bool Ext(ushort vk) { return (vk >= 33 && vk <= 46) || vk == 91 || vk == 92 || vk == 93 || vk == 111 || vk == 144; }

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} }
  public static string Pos() { POINT p; GetCursorPos(out p); return p.x + " " + p.y; }
  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(60);
    uint down = 2, up = 4;
    if (button == "right") { down = 8; up = 16; } else if (button == "middle") { down = 32; up = 64; }
    for (int c = 0; c < count; c++) { Send(new[] { M(down, 0), M(up, 0) }); System.Threading.Thread.Sleep(70); }
  }
  public static void Scroll(int x, int y, int notches) { SetCursorPos(x, y); Send(new[] { M(0x0800, (uint)(notches * 120)) }); }
  public static void Type(string text) {
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { Send(new[] { K(13, 0, 0), K(13, 0, 2) }); }
      else { Send(new[] { K(0, ch, 4), K(0, ch, 4 | 2) }); }
      System.Threading.Thread.Sleep(8);
    }
  }
  public static void Keys(ushort[] vks) {
    var list = new System.Collections.Generic.List<INPUT>();
    foreach (var vk in vks) list.Add(K(vk, 0, Ext(vk) ? 1u : 0u));
    for (int i = vks.Length - 1; i >= 0; i--) list.Add(K(vks[i], 0, (Ext(vks[i]) ? 1u : 0u) | 2u));
    Send(list.ToArray());
  }
}
"@
[FreedomInput]::DpiAware()
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    $out = 'ok'
    switch ($p[0]) {
      'pos'    { $out = 'ok ' + [FreedomInput]::Pos() }
      'move'   { [void][FreedomInput]::SetCursorPos([int]$p[1], [int]$p[2]) }
      'click'  { [FreedomInput]::Click([int]$p[1], [int]$p[2], $p[3], [int]$p[4]) }
      'scroll' { [FreedomInput]::Scroll([int]$p[1], [int]$p[2], [int]$p[3]) }
      'type'   { [FreedomInput]::Type([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
      'keys'   { [FreedomInput]::Keys([uint16[]]($p[1].Split(','))) }
      default  { $out = 'err unknown command' }
    }
    [Console]::Out.WriteLine($out)
  } catch { [Console]::Out.WriteLine('err ' + $_.Exception.Message) }
  [Console]::Out.Flush()
}
`;

// Key names the AI may use -> Windows virtual-key codes.
const VK = {
  backspace: 8, tab: 9, enter: 13, return: 13, shift: 16, ctrl: 17, control: 17, alt: 18, pause: 19, capslock: 20,
  esc: 27, escape: 27, space: 32, pageup: 33, pagedown: 34, end: 35, home: 36,
  left: 37, up: 38, right: 39, down: 40, insert: 45, delete: 46, del: 46,
  win: 91, windows: 91, meta: 91, cmd: 91, super: 91, menu: 93,
  f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
  ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222,
};
function keyCodes(combo) {
  return String(combo).toLowerCase().split('+').map((k) => k.trim()).filter(Boolean).map((k) => {
    if (VK[k]) return VK[k];
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
    throw new Error(`Unknown key "${k}"`);
  });
}

class WinInput {
  constructor() {
    this.proc = null;
    this.queue = [];
    this.buf = '';
  }

  start() {
    if (this.proc) return this.ready;
    const file = path.join(os.tmpdir(), 'freedom-input.ps1');
    fs.writeFileSync(file, PS_SCRIPT, 'utf8');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    this.ready = new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.on('error', reject);
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const w = this.queue.shift();
        if (!w) continue;
        if (line.startsWith('err')) w.reject(new Error(line.slice(4)));
        else w.resolve(line);
      }
    });
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => {
      this.proc = null;
      this.queue.splice(0).forEach((w) => w.reject(new Error('input helper exited')));
    });
    return this.ready;
  }

  async cmd(line) {
    await this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(line + '\n');
    });
  }

  click(x, y, button = 'left', count = 1) { return this.cmd(`click ${Math.round(x)} ${Math.round(y)} ${button} ${count}`); }
  scroll(x, y, notches) { return this.cmd(`scroll ${Math.round(x)} ${Math.round(y)} ${Math.round(notches)}`); }
  type(text) { return this.cmd(`type ${Buffer.from(String(text), 'utf8').toString('base64')}`); }
  keys(combo) { return this.cmd(`keys ${keyCodes(combo).join(',')}`); }
  move(x, y) { return this.cmd(`move ${Math.round(x)} ${Math.round(y)}`); }
  async pos() { const [, x, y] = (await this.cmd('pos')).split(' '); return { x: +x, y: +y }; }

  stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); this.proc = null; } }
}

module.exports = { WinInput, keyCodes };
