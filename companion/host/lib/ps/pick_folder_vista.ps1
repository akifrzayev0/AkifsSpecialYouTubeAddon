# pick_folder_vista.ps1 - modern Common Item Dialog (IFileOpenDialog + FOS_PICKFOLDERS) via Add-Type.
# Part of Akif's Special YouTube Addon companion. Keep this file pure ASCII (PowerShell 5.1 reads
# BOM-less scripts in the ANSI code page).
# Inputs (environment, UTF-16 safe): AKIF_PICK_TITLE (window caption), AKIF_PICK_INITIAL (start folder),
#   AKIF_PICK_OK (button label, optional), AKIF_PICK_OWNER (HWND as decimal, optional; 0/empty => TopMost owner form)
# Output: one UTF-8 JSON object as raw bytes: {"ok":true,"path":...} | {"ok":true,"cancelled":true} | {"ok":false,"error":...}
#   | {"ok":false,"reason":"language_mode","mode":...} (plain ASCII text) when the dialog cannot work here at all.
# AppLocker / Windows Defender Application Control run scripts in Constrained Language Mode: Add-Type and every
# .NET call below (even Out-Json) are blocked there. Say so first, with nothing but core-language features.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output ('{"ok":false,"reason":"language_mode","mode":"' + $ExecutionContext.SessionState.LanguageMode + '"}')
  exit 1
}
$ErrorActionPreference = 'Stop'
function Out-Json($obj) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $obj -Compress))
  $s = [Console]::OpenStandardOutput(); $s.Write($bytes, 0, $bytes.Length); $s.Flush()
}
$src = @'
using System;
using System.Runtime.InteropServices;
public static class AkifFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialogCoClass {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

  // Returns the chosen folder, or null when the user cancelled.
  public static string Pick(IntPtr owner, string title, string initialDir, string okLabel) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogCoClass();
    try {
      uint opts; dlg.GetOptions(out opts);
      // FOS_PICKFOLDERS 0x20 | FOS_FORCEFILESYSTEM 0x40 | FOS_NOCHANGEDIR 0x8 | FOS_PATHMUSTEXIST 0x800
      dlg.SetOptions(opts | 0x20 | 0x40 | 0x8 | 0x800);
      if (!String.IsNullOrEmpty(title)) dlg.SetTitle(title);
      if (!String.IsNullOrEmpty(okLabel)) dlg.SetOkButtonLabel(okLabel);
      if (!String.IsNullOrEmpty(initialDir)) {
        try { IShellItem f; SHCreateItemFromParsingName(initialDir, IntPtr.Zero, typeof(IShellItem).GUID, out f); dlg.SetFolder(f); } catch { }
      }
      int hr = dlg.Show(owner);
      if (hr == unchecked((int)0x800704C7)) return null; // HRESULT_FROM_WIN32(ERROR_CANCELLED)
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      IShellItem item; dlg.GetResult(out item);
      string path; item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
      return path;
    } finally { Marshal.ReleaseComObject(dlg); }
  }
}
'@
try {
  Add-Type -TypeDefinition $src -Language CSharp
  $ownerHandle = [IntPtr]::Zero
  $form = $null
  if ($env:AKIF_PICK_OWNER -and [Int64]$env:AKIF_PICK_OWNER -ne 0) {
    $ownerHandle = [IntPtr][Int64]$env:AKIF_PICK_OWNER
  } else {
    # An invisible TopMost owner window keeps the dialog in front of the browser.
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.TopMost = $true; $form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'
    $form.StartPosition = 'CenterScreen'; $form.Size = New-Object System.Drawing.Size(1, 1); $form.Opacity = 0
    $form.Show(); $form.Activate()
    $ownerHandle = $form.Handle
  }
  $p = [AkifFolderPicker]::Pick($ownerHandle, $env:AKIF_PICK_TITLE, $env:AKIF_PICK_INITIAL, $env:AKIF_PICK_OK)
  if ($form) { $form.Close() }
  if ($null -eq $p) { Out-Json @{ ok = $true; cancelled = $true } } else { Out-Json @{ ok = $true; path = $p } }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
