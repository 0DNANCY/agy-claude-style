using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AgyClaudeStyle
{
    public sealed class InstallerOptions
    {
        public bool Uninstall;
        public bool Silent;
        public bool Popup;
        public bool StatusOnly;
        public string InstallDir;
        public string OutFile;
    }

    public sealed class AntigravityDetectInfo
    {
        public string ExePath;
        public string Version;
        public bool Installed;
    }

    public sealed class LsDaemonInfo
    {
        public int Pid;
        public int HttpPort;
        public string CsrfToken;
    }

    public sealed class OperationResult
    {
        public bool Ok;
        public string Mode;
        public string Headline;
        public string Detail;
        public string InstallDir;
        public string PluginDataDir;
        public string AntigravityExe;
        public string AntigravityVersion;
        public bool PreservedExistingConfig;
        public bool MigratedLegacyConfig;
        public bool LegacyCleaned;
        public bool PluginEnabled;
        public bool LsHotReloaded;
        public int FileCount;
        public bool SelfDeleteScheduled;
    }

    public static class InstallerCore
    {
        public const string PluginName = "agy-claude-style";
        public const string SidecarName = "agy-claude-style/panel";
        public const string UninstallRegSubKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AgyClaudeStyle";
        public const string DisplayName = "AGY Claude Style (Antigravity Desktop 原生插件)";
        private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

        public static string GetTestSystemRoot()
        {
            string raw = Environment.GetEnvironmentVariable("AGY_CS_TEST_SYSTEM_ROOT");
            return string.IsNullOrEmpty(raw) ? null : Path.GetFullPath(raw.Trim());
        }

        public static bool IsTestSandbox()
        {
            return !string.IsNullOrEmpty(GetTestSystemRoot());
        }

        public static string ResolveGeminiDir()
        {
            string testRoot = GetTestSystemRoot();
            if (!string.IsNullOrEmpty(testRoot))
            {
                return Path.Combine(testRoot, ".gemini");
            }
            string envDir = Environment.GetEnvironmentVariable("ANTIGRAVITY_GEMINI_DIR");
            if (!string.IsNullOrEmpty(envDir) && envDir.Trim().Length > 0)
            {
                return Path.GetFullPath(envDir.Trim());
            }
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".gemini");
        }

        public static string GetDefaultInstallDir()
        {
            return Path.Combine(Path.Combine(Path.Combine(ResolveGeminiDir(), "config"), "plugins"), PluginName);
        }

        public static string GetPluginDataDir()
        {
            return Path.Combine(Path.Combine(Path.Combine(ResolveGeminiDir(), "antigravity"), "plugin_data"), PluginName);
        }

        public static string GetAntigravityConfigPath()
        {
            return Path.Combine(Path.Combine(ResolveGeminiDir(), "config"), "config.json");
        }

        public static string GetLegacyInstallDir()
        {
            string testRoot = GetTestSystemRoot();
            if (!string.IsNullOrEmpty(testRoot))
            {
                return Path.Combine(Path.Combine(testRoot, "LegacyLocalAppData"), PluginName);
            }
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, PluginName);
        }

        public static List<string> GetLegacyShortcutPaths()
        {
            List<string> paths = new List<string>();
            string testRoot = GetTestSystemRoot();
            if (!string.IsNullOrEmpty(testRoot))
            {
                paths.Add(Path.Combine(Path.Combine(testRoot, "Startup"), "AGY-Claude-Style.lnk"));
                paths.Add(Path.Combine(Path.Combine(testRoot, "StartMenu"), "Antigravity (AGY Claude Style).lnk"));
                paths.Add(Path.Combine(Path.Combine(testRoot, "Desktop"), "Antigravity (AGY Claude Style).lnk"));
                return paths;
            }
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            string programsDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (!string.IsNullOrEmpty(startupDir)) paths.Add(Path.Combine(startupDir, "AGY-Claude-Style.lnk"));
            if (!string.IsNullOrEmpty(programsDir))
            {
                paths.Add(Path.Combine(Path.Combine(programsDir, "Antigravity"), "Antigravity (AGY Claude Style).lnk"));
                paths.Add(Path.Combine(programsDir, "Antigravity (AGY Claude Style).lnk"));
            }
            if (!string.IsNullOrEmpty(desktopDir)) paths.Add(Path.Combine(desktopDir, "Antigravity (AGY Claude Style).lnk"));
            return paths;
        }

        public static AntigravityDetectInfo DetectAntigravity()
        {
            AntigravityDetectInfo info = new AntigravityDetectInfo();
            string[] candidates = new string[]
            {
                Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"), Path.Combine("Antigravity", "Antigravity.exe")),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Path.Combine("Antigravity", "Antigravity.exe")),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Path.Combine("Antigravity", "Antigravity.exe"))
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                string c = candidates[i];
                if (!string.IsNullOrEmpty(c) && File.Exists(c))
                {
                    info.ExePath = c;
                    info.Installed = true;
                    try
                    {
                        FileVersionInfo fvi = FileVersionInfo.GetVersionInfo(c);
                        info.Version = !string.IsNullOrEmpty(fvi.ProductVersion) ? fvi.ProductVersion : fvi.FileVersion;
                    }
                    catch { }
                    break;
                }
            }
            return info;
        }

        private static bool IsPidAlive(int pid)
        {
            if (pid <= 0) return false;
            try
            {
                Process p = Process.GetProcessById(pid);
                return !p.HasExited;
            }
            catch
            {
                return false;
            }
        }

        public static List<LsDaemonInfo> DiscoverRunningLanguageServers()
        {
            List<LsDaemonInfo> result = new List<LsDaemonInfo>();
            if (IsTestSandbox()) return result;
            string daemonDir = Path.Combine(Path.Combine(ResolveGeminiDir(), "antigravity"), "daemon");
            if (!Directory.Exists(daemonDir)) return result;
            string[] files = Directory.GetFiles(daemonDir, "*.json");
            for (int i = 0; i < files.Length; i++)
            {
                try
                {
                    Dictionary<string, object> doc = MiniJson.ParseObject(File.ReadAllText(files[i], Utf8NoBom));
                    object pidObj;
                    object portObj;
                    object csrfObj;
                    if (!doc.TryGetValue("pid", out pidObj) || !doc.TryGetValue("httpPort", out portObj) || !doc.TryGetValue("csrfToken", out csrfObj))
                    {
                        continue;
                    }
                    int pid = Convert.ToInt32(pidObj);
                    int port = Convert.ToInt32(portObj);
                    string csrf = csrfObj as string;
                    if (pid > 0 && port > 0 && !string.IsNullOrEmpty(csrf) && IsPidAlive(pid))
                    {
                        LsDaemonInfo d = new LsDaemonInfo();
                        d.Pid = pid;
                        d.HttpPort = port;
                        d.CsrfToken = csrf;
                        result.Add(d);
                    }
                }
                catch { }
            }
            return result;
        }

        private static bool CallLsRpc(LsDaemonInfo daemon, string method, Dictionary<string, object> body, int timeoutMs)
        {
            try
            {
                string url = "http://127.0.0.1:" + daemon.HttpPort + "/exa.language_server_pb.LanguageServerService/" + method;
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.ContentType = "application/json";
                req.Headers.Add("Connect-Protocol-Version", "1");
                req.Headers.Add("x-codeium-csrf-token", daemon.CsrfToken);
                req.Headers.Add("x-antigravity-csrf-token", daemon.CsrfToken);
                byte[] payload = Utf8NoBom.GetBytes(MiniJson.Stringify(body, false));
                req.ContentLength = payload.Length;
                using (Stream reqStream = req.GetRequestStream())
                {
                    reqStream.Write(payload, 0, payload.Length);
                }
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return ((int)resp.StatusCode) >= 200 && ((int)resp.StatusCode) < 300;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetLsPluginState(List<LsDaemonInfo> daemons, bool enabled)
        {
            if (daemons == null || daemons.Count == 0) return false;
            Dictionary<string, object> pluginState = new Dictionary<string, object>(StringComparer.Ordinal);
            pluginState["enabled"] = enabled;
            Dictionary<string, object> pluginsMap = new Dictionary<string, object>(StringComparer.Ordinal);
            pluginsMap[PluginName] = pluginState;

            Dictionary<string, object> sidecarState = new Dictionary<string, object>(StringComparer.Ordinal);
            sidecarState["enabled"] = enabled;
            Dictionary<string, object> sidecarsMap = new Dictionary<string, object>(StringComparer.Ordinal);
            sidecarsMap[SidecarName] = sidecarState;

            Dictionary<string, object> body = new Dictionary<string, object>(StringComparer.Ordinal);
            body["plugins"] = pluginsMap;
            body["sidecars"] = sidecarsMap;

            bool anyOk = false;
            for (int i = 0; i < daemons.Count; i++)
            {
                if (CallLsRpc(daemons[i], "JetboxWriteState", body, 2500))
                {
                    anyOk = true;
                }
            }
            return anyOk;
        }

        private static bool TryDeleteLsPlugin(List<LsDaemonInfo> daemons)
        {
            if (daemons == null || daemons.Count == 0) return false;
            Dictionary<string, object> body = new Dictionary<string, object>(StringComparer.Ordinal);
            body["pluginName"] = PluginName;
            bool anyOk = false;
            for (int i = 0; i < daemons.Count; i++)
            {
                if (CallLsRpc(daemons[i], "DeletePlugin", body, 2500))
                {
                    anyOk = true;
                }
            }
            return anyOk;
        }

        public static bool ReadPluginEnabledState()
        {
            string cfgPath = GetAntigravityConfigPath();
            if (!File.Exists(cfgPath)) return false;
            try
            {
                Dictionary<string, object> doc = MiniJson.ParseObject(File.ReadAllText(cfgPath, Utf8NoBom));
                object pluginsObj;
                if (!doc.TryGetValue("plugins", out pluginsObj)) return false;
                Dictionary<string, object> plugins = pluginsObj as Dictionary<string, object>;
                if (plugins == null) return false;
                object entryObj;
                if (!plugins.TryGetValue(PluginName, out entryObj)) return false;
                if (entryObj is bool) return (bool)entryObj;
                Dictionary<string, object> entry = entryObj as Dictionary<string, object>;
                if (entry == null) return false;
                object enabledObj;
                if (!entry.TryGetValue("enabled", out enabledObj)) return true;
                if (enabledObj is bool) return (bool)enabledObj;
            }
            catch { }
            return false;
        }

        public static void SetPluginEnabledInConfigFile(bool enable)
        {
            string cfgPath = GetAntigravityConfigPath();
            if (!enable && !File.Exists(cfgPath)) return;
            string cfgDir = Path.GetDirectoryName(cfgPath);
            if (!string.IsNullOrEmpty(cfgDir) && !Directory.Exists(cfgDir))
            {
                Directory.CreateDirectory(cfgDir);
            }
            Dictionary<string, object> doc = null;
            if (File.Exists(cfgPath))
            {
                try
                {
                    doc = MiniJson.ParseObject(File.ReadAllText(cfgPath, Utf8NoBom));
                }
                catch
                {
                    doc = null;
                }
            }
            if (doc == null)
            {
                doc = new Dictionary<string, object>(StringComparer.Ordinal);
            }
            Dictionary<string, object> plugins = null;
            object pluginsObj;
            if (doc.TryGetValue("plugins", out pluginsObj))
            {
                plugins = pluginsObj as Dictionary<string, object>;
            }
            if (plugins == null)
            {
                plugins = new Dictionary<string, object>(StringComparer.Ordinal);
                doc["plugins"] = plugins;
            }

            if (enable)
            {
                Dictionary<string, object> entry = null;
                object existingObj;
                if (plugins.TryGetValue(PluginName, out existingObj))
                {
                    entry = existingObj as Dictionary<string, object>;
                }
                if (entry == null)
                {
                    entry = new Dictionary<string, object>(StringComparer.Ordinal);
                }
                entry["enabled"] = true;
                plugins[PluginName] = entry;
            }
            else
            {
                plugins.Remove(PluginName);
            }

            WriteTextAtomic(cfgPath, MiniJson.Stringify(doc, true) + "\n");
        }

        private static void WriteTextAtomic(string path, string content)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }
            string tmp = path + ".tmp." + Process.GetCurrentProcess().Id + "." + Thread.CurrentThread.ManagedThreadId;
            File.WriteAllText(tmp, content, Utf8NoBom);
            try
            {
                File.Copy(tmp, path, true);
            }
            finally
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            }
        }

        private static bool TryStripDeprecatedFieldsAndWriteConfig(string srcPath, string destPath)
        {
            try
            {
                Dictionary<string, object> parsed = MiniJson.ParseObject(File.ReadAllText(srcPath, Utf8NoBom));
                parsed.Remove("exitOnHostClose");
                WriteTextAtomic(destPath, MiniJson.Stringify(parsed, true) + "\n");
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void StopLegacyWatchers()
        {
            if (IsTestSandbox()) return;
            try
            {
                Process[] procs = Process.GetProcessesByName("agy-claude-style-watcher");
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        if (!procs[i].HasExited)
                        {
                            procs[i].Kill();
                            procs[i].WaitForExit(1500);
                        }
                    }
                    catch { }
                    finally
                    {
                        try { procs[i].Dispose(); } catch { }
                    }
                }
            }
            catch { }
        }

        public static bool CleanupLegacyExternalArtifacts(string installDir)
        {
            bool cleaned = false;
            StopLegacyWatchers();

            List<string> shortcuts = GetLegacyShortcutPaths();
            for (int i = 0; i < shortcuts.Count; i++)
            {
                string lnk = shortcuts[i];
                try
                {
                    if (File.Exists(lnk))
                    {
                        File.Delete(lnk);
                        cleaned = true;
                    }
                }
                catch { }
            }

            string legacyDir = GetLegacyInstallDir();
            if (!string.IsNullOrEmpty(legacyDir) &&
                Directory.Exists(legacyDir) &&
                !string.Equals(Path.GetFullPath(legacyDir).TrimEnd('\\'), Path.GetFullPath(installDir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    Directory.Delete(legacyDir, true);
                    cleaned = true;
                }
                catch { }
            }

            string[] legacyInsidePlugin = new string[]
            {
                "agy-claude-style-watcher.exe",
                "agy-claude-style-installer.exe",
                "manifest.json",
                ".install-mode",
                ".watch.pid",
                "Antigravity (AGY Claude Style).lnk"
            };
            if (Directory.Exists(installDir))
            {
                for (int i = 0; i < legacyInsidePlugin.Length; i++)
                {
                    string f = Path.Combine(installDir, legacyInsidePlugin[i]);
                    try
                    {
                        if (File.Exists(f))
                        {
                            File.Delete(f);
                            cleaned = true;
                        }
                    }
                    catch { }
                }
            }
            return cleaned;
        }

        private static int ExtractEmbeddedPayload(string installDir)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream stream = asm.GetManifestResourceStream("AGY_PAYLOAD.zip"))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("安装包内部缺少嵌入式原生插件资源 AGY_PAYLOAD.zip");
                }
                if (!Directory.Exists(installDir))
                {
                    Directory.CreateDirectory(installDir);
                }
                string fullInstallRoot = Path.GetFullPath(installDir);
                if (!fullInstallRoot.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
                {
                    fullInstallRoot += Path.DirectorySeparatorChar;
                }
                int count = 0;
                using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        if (string.IsNullOrEmpty(entry.Name)) continue;
                        string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string destPath = Path.GetFullPath(Path.Combine(installDir, rel));
                        if (!destPath.StartsWith(fullInstallRoot, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("非法的插件资源路径: " + entry.FullName);
                        }
                        string parent = Path.GetDirectoryName(destPath);
                        if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent))
                        {
                            Directory.CreateDirectory(parent);
                        }
                        entry.ExtractToFile(destPath, true);
                        count++;
                    }
                }
                return count;
            }
        }

        public static string ReadInstalledPluginVersion(string installDir)
        {
            string pluginJson = Path.Combine(installDir, "plugin.json");
            if (!File.Exists(pluginJson)) return null;
            try
            {
                Dictionary<string, object> parsed = MiniJson.ParseObject(File.ReadAllText(pluginJson, Utf8NoBom));
                object verObj;
                if (parsed.TryGetValue("version", out verObj))
                {
                    return verObj as string;
                }
            }
            catch { }
            return null;
        }

        private static void RegisterWindowsUninstall(string installDir, string uninstallerExePath, string version)
        {
            if (IsTestSandbox()) return;
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallRegSubKey))
                {
                    if (key == null) return;
                    key.SetValue("DisplayName", DisplayName, RegistryValueKind.String);
                    key.SetValue("DisplayVersion", string.IsNullOrEmpty(version) ? "3.0.0" : version, RegistryValueKind.String);
                    key.SetValue("Publisher", "0dnancy (AGY Claude Style)", RegistryValueKind.String);
                    key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
                    key.SetValue("DisplayIcon", uninstallerExePath, RegistryValueKind.String);
                    key.SetValue("UninstallString", "\"" + uninstallerExePath + "\" --uninstall", RegistryValueKind.String);
                    key.SetValue("QuietUninstallString", "\"" + uninstallerExePath + "\" --uninstall --silent", RegistryValueKind.String);
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            catch { }
        }

        private static void UnregisterWindowsUninstall()
        {
            if (IsTestSandbox()) return;
            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(UninstallRegSubKey, false);
            }
            catch { }
        }

        public static OperationResult RunInstall(InstallerOptions opts, Action<int, string> progress)
        {
            string installDir = string.IsNullOrEmpty(opts.InstallDir)
                ? GetDefaultInstallDir()
                : Path.GetFullPath(opts.InstallDir);
            string pluginDataDir = GetPluginDataDir();
            string legacyDir = GetLegacyInstallDir();

            if (progress != null) progress(10, "正在准备插件配置目录...");
            if (!Directory.Exists(pluginDataDir))
            {
                Directory.CreateDirectory(pluginDataDir);
            }

            bool preservedExisting = false;
            bool migratedLegacy = false;
            string activeCfgPath = Path.Combine(pluginDataDir, "config.json");
            string legacyCfgPath = Path.Combine(legacyDir, "config.json");

            if (File.Exists(activeCfgPath))
            {
                preservedExisting = TryStripDeprecatedFieldsAndWriteConfig(activeCfgPath, activeCfgPath);
                if (!preservedExisting) preservedExisting = true;
            }
            else if (File.Exists(legacyCfgPath))
            {
                migratedLegacy = TryStripDeprecatedFieldsAndWriteConfig(legacyCfgPath, activeCfgPath);
                if (migratedLegacy) preservedExisting = true;
            }

            if (progress != null) progress(25, "正在检查运行中的 Antigravity 并释放旧版文件锁...");
            List<LsDaemonInfo> daemons = DiscoverRunningLanguageServers();
            bool lsPaused = TrySetLsPluginState(daemons, false);
            if (lsPaused)
            {
                Thread.Sleep(500);
            }

            bool legacyCleaned = CleanupLegacyExternalArtifacts(installDir);

            if (progress != null) progress(55, "正在部署原生插件文件到 ~/.gemini/config/plugins/agy-claude-style...");
            int fileCount = ExtractEmbeddedPayload(installDir);

            if (!File.Exists(activeCfgPath))
            {
                string exampleCfg = Path.Combine(installDir, "config.example.json");
                if (File.Exists(exampleCfg))
                {
                    File.Copy(exampleCfg, activeCfgPath, false);
                }
            }

            if (progress != null) progress(80, "正在启用 Antigravity Desktop 原生插件...");
            SetPluginEnabledInConfigFile(true);
            bool lsEnabled = TrySetLsPluginState(daemons, true);

            string selfExe = Assembly.GetExecutingAssembly().Location;
            string uninstallerPath = Path.Combine(pluginDataDir, "agy-claude-style-uninstaller.exe");
            try
            {
                if (!string.IsNullOrEmpty(selfExe) && File.Exists(selfExe) &&
                    !string.Equals(Path.GetFullPath(selfExe), Path.GetFullPath(uninstallerPath), StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(selfExe, uninstallerPath, true);
                }
            }
            catch { }

            string version = ReadInstalledPluginVersion(installDir);
            RegisterWindowsUninstall(installDir, File.Exists(uninstallerPath) ? uninstallerPath : selfExe, version);

            if (progress != null) progress(100, "原生插件部署完成。");
            AntigravityDetectInfo agInfo = DetectAntigravity();

            OperationResult res = new OperationResult();
            res.Ok = true;
            res.Mode = "install";
            res.InstallDir = installDir;
            res.PluginDataDir = pluginDataDir;
            res.AntigravityExe = agInfo.ExePath;
            res.AntigravityVersion = agInfo.Version;
            res.PreservedExistingConfig = preservedExisting;
            res.MigratedLegacyConfig = migratedLegacy;
            res.LegacyCleaned = legacyCleaned;
            res.PluginEnabled = ReadPluginEnabledState();
            res.LsHotReloaded = lsEnabled;
            res.FileCount = fileCount;
            res.Headline = "AGY Claude Style 原生插件已安装！";

            StringBuilder detail = new StringBuilder();
            detail.AppendLine("已以零后台进程模式部署 Antigravity Desktop 原生插件，共写入 " + fileCount + " 个文件。");
            detail.AppendLine("插件目录：" + installDir);
            detail.AppendLine("用户配置：" + activeCfgPath + (migratedLegacy ? "（已从旧版目录迁移）" : preservedExisting ? "（已保留现有配置）" : "（已生成默认配置）"));
            if (legacyCleaned)
            {
                detail.AppendLine("旧版清理：已自动停止并清理旧版外部 Watcher / 自启与快捷方式残留。");
            }
            detail.AppendLine(lsEnabled
                ? "生效方式：已通过 Antigravity Language Server 热启用，插件宿主正在自动注入样式与右侧 Claude Style 控制室。"
                : "生效方式：已写入插件启用配置；打开 Antigravity Desktop 后将由原生插件自动完成注入（无需外部常驻程序）。");
            res.Detail = detail.ToString().Trim();
            return res;
        }

        public static OperationResult RunUninstall(InstallerOptions opts, Action<int, string> progress)
        {
            string installDir = string.IsNullOrEmpty(opts.InstallDir)
                ? GetDefaultInstallDir()
                : Path.GetFullPath(opts.InstallDir);
            string pluginDataDir = GetPluginDataDir();

            if (progress != null) progress(20, "正在通知 Antigravity 停用并还原界面...");
            List<LsDaemonInfo> daemons = DiscoverRunningLanguageServers();
            bool lsStopped = TryDeleteLsPlugin(daemons);
            if (!lsStopped)
            {
                lsStopped = TrySetLsPluginState(daemons, false);
            }
            if (lsStopped)
            {
                Thread.Sleep(500);
            }

            SetPluginEnabledInConfigFile(false);

            if (progress != null) progress(55, "正在清理原生插件目录与旧版残留...");
            bool legacyCleaned = CleanupLegacyExternalArtifacts(installDir);

            string selfExe = Assembly.GetExecutingAssembly().Location;
            string fullSelf = !string.IsNullOrEmpty(selfExe) ? Path.GetFullPath(selfExe) : "";
            string fullInstall = Path.GetFullPath(installDir);
            bool runningInsideInstallDir = !string.IsNullOrEmpty(fullSelf) &&
                fullSelf.StartsWith(fullInstall.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);

            if (!runningInsideInstallDir && Directory.Exists(installDir))
            {
                for (int attempt = 0; attempt < 5; attempt++)
                {
                    try
                    {
                        Directory.Delete(installDir, true);
                        break;
                    }
                    catch
                    {
                        Thread.Sleep(250);
                    }
                }
            }

            string uninstallerPath = Path.Combine(pluginDataDir, "agy-claude-style-uninstaller.exe");
            bool runningUninstaller = !string.IsNullOrEmpty(fullSelf) &&
                string.Equals(fullSelf, Path.GetFullPath(uninstallerPath), StringComparison.OrdinalIgnoreCase);
            if (!runningUninstaller && File.Exists(uninstallerPath))
            {
                try { File.Delete(uninstallerPath); } catch { }
            }

            UnregisterWindowsUninstall();

            if (progress != null) progress(100, "卸载完成。");
            AntigravityDetectInfo agInfo = DetectAntigravity();
            OperationResult res = new OperationResult();
            res.Ok = true;
            res.Mode = "uninstall";
            res.InstallDir = installDir;
            res.PluginDataDir = pluginDataDir;
            res.AntigravityExe = agInfo.ExePath;
            res.AntigravityVersion = agInfo.Version;
            res.LegacyCleaned = legacyCleaned;
            res.PluginEnabled = ReadPluginEnabledState();
            res.LsHotReloaded = lsStopped;
            res.SelfDeleteScheduled = runningInsideInstallDir || runningUninstaller;
            res.Headline = "已卸载 AGY Claude Style 原生插件";
            res.Detail = "已移除原生插件目录：" + installDir + "\n用户偏好配置保留在：" + Path.Combine(pluginDataDir, "config.json");
            return res;
        }

        public static Dictionary<string, object> BuildStatusDictionary(InstallerOptions opts)
        {
            string installDir = string.IsNullOrEmpty(opts.InstallDir)
                ? GetDefaultInstallDir()
                : Path.GetFullPath(opts.InstallDir);
            string pluginDataDir = GetPluginDataDir();
            string legacyDir = GetLegacyInstallDir();
            AntigravityDetectInfo ag = DetectAntigravity();
            string version = ReadInstalledPluginVersion(installDir);

            bool hasLegacyShortcut = false;
            List<string> shortcuts = GetLegacyShortcutPaths();
            for (int i = 0; i < shortcuts.Count; i++)
            {
                if (File.Exists(shortcuts[i]))
                {
                    hasLegacyShortcut = true;
                    break;
                }
            }

            Dictionary<string, object> d = new Dictionary<string, object>(StringComparer.Ordinal);
            d["installed"] = File.Exists(Path.Combine(installDir, "plugin.json"));
            d["installedVersion"] = version;
            d["pluginEnabled"] = ReadPluginEnabledState();
            d["installDir"] = installDir;
            d["pluginDataDir"] = pluginDataDir;
            d["antigravityExe"] = ag.ExePath;
            d["antigravityVersion"] = ag.Version;
            d["hasConfig"] = File.Exists(Path.Combine(pluginDataDir, "config.json"));
            d["hasLegacyInstall"] = Directory.Exists(legacyDir) || hasLegacyShortcut;
            return d;
        }

        public static void ScheduleSelfDeleteIfNeeded(string installDir, string pluginDataDir)
        {
            try
            {
                string selfExe = Assembly.GetExecutingAssembly().Location;
                if (string.IsNullOrEmpty(selfExe)) return;
                string fullSelf = Path.GetFullPath(selfExe);
                string uninstallerPath = Path.Combine(pluginDataDir, "agy-claude-style-uninstaller.exe");
                bool inInstallDir = fullSelf.StartsWith(Path.GetFullPath(installDir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
                bool isStoredUninstaller = string.Equals(fullSelf, Path.GetFullPath(uninstallerPath), StringComparison.OrdinalIgnoreCase);
                if (!inInstallDir && !isStoredUninstaller) return;

                string cmdArgs = inInstallDir
                    ? "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + installDir + "\""
                    : "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + uninstallerPath + "\"";
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmdArgs);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch { }
        }
    }

    public sealed class InstallerForm : Form
    {
        private readonly InstallerOptions _opts;
        private readonly Label _statusTitle;
        private readonly Label _statusBody;
        private readonly ProgressBar _progress;
        private readonly TextBox _logBox;
        private readonly Button _btnInstall;
        private readonly Button _btnUninstall;
        private readonly Button _btnOpenDir;
        private readonly Button _btnLaunchAg;
        private readonly Button _btnClose;
        private bool _busy;

        public InstallerForm(InstallerOptions opts)
        {
            _opts = opts;
            Text = "AGY Claude Style — 原生插件安装器";
            ClientSize = new Size(580, 470);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(24, 22, 21);
            ForeColor = Color.FromArgb(244, 240, 234);
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);

            try
            {
                Icon appIcon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
                if (appIcon != null) Icon = appIcon;
            }
            catch { }

            Label titleLbl = new Label();
            titleLbl.Text = "AGY Claude Style 原生插件安装器";
            titleLbl.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
            titleLbl.ForeColor = Color.FromArgb(224, 122, 88);
            titleLbl.SetBounds(24, 18, 532, 30);
            Controls.Add(titleLbl);

            Label subLbl = new Label();
            subLbl.Text = "零后台守护进程 · 仅由 Antigravity Desktop 原生插件自动注入与控制";
            subLbl.ForeColor = Color.FromArgb(182, 174, 166);
            subLbl.SetBounds(24, 50, 532, 20);
            Controls.Add(subLbl);

            Panel card = new Panel();
            card.BackColor = Color.FromArgb(34, 31, 29);
            card.SetBounds(24, 82, 532, 134);
            Controls.Add(card);

            _statusTitle = new Label();
            _statusTitle.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
            _statusTitle.ForeColor = Color.FromArgb(244, 240, 234);
            _statusTitle.SetBounds(16, 12, 500, 22);
            card.Controls.Add(_statusTitle);

            _statusBody = new Label();
            _statusBody.ForeColor = Color.FromArgb(196, 188, 180);
            _statusBody.SetBounds(16, 40, 500, 84);
            card.Controls.Add(_statusBody);

            _progress = new ProgressBar();
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Minimum = 0;
            _progress.Maximum = 100;
            _progress.SetBounds(24, 230, 532, 16);
            Controls.Add(_progress);

            _logBox = new TextBox();
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.ScrollBars = ScrollBars.Vertical;
            _logBox.BackColor = Color.FromArgb(19, 18, 17);
            _logBox.ForeColor = Color.FromArgb(215, 208, 200);
            _logBox.BorderStyle = BorderStyle.FixedSingle;
            _logBox.SetBounds(24, 258, 532, 144);
            Controls.Add(_logBox);

            _btnInstall = new Button();
            _btnInstall.Text = "安装 / 更新插件";
            _btnInstall.BackColor = Color.FromArgb(217, 119, 87);
            _btnInstall.ForeColor = Color.White;
            _btnInstall.FlatStyle = FlatStyle.Flat;
            _btnInstall.FlatAppearance.BorderSize = 0;
            _btnInstall.SetBounds(24, 416, 138, 34);
            _btnInstall.Click += delegate { RunAction(false); };
            Controls.Add(_btnInstall);

            _btnUninstall = new Button();
            _btnUninstall.Text = "卸载插件";
            _btnUninstall.BackColor = Color.FromArgb(52, 47, 44);
            _btnUninstall.ForeColor = Color.FromArgb(244, 240, 234);
            _btnUninstall.FlatStyle = FlatStyle.Flat;
            _btnUninstall.FlatAppearance.BorderSize = 0;
            _btnUninstall.SetBounds(172, 416, 92, 34);
            _btnUninstall.Click += delegate { RunAction(true); };
            Controls.Add(_btnUninstall);

            _btnOpenDir = new Button();
            _btnOpenDir.Text = "打开插件目录";
            _btnOpenDir.BackColor = Color.FromArgb(52, 47, 44);
            _btnOpenDir.ForeColor = Color.FromArgb(244, 240, 234);
            _btnOpenDir.FlatStyle = FlatStyle.Flat;
            _btnOpenDir.FlatAppearance.BorderSize = 0;
            _btnOpenDir.SetBounds(274, 416, 108, 34);
            _btnOpenDir.Click += delegate { OpenPluginDir(); };
            Controls.Add(_btnOpenDir);

            _btnLaunchAg = new Button();
            _btnLaunchAg.Text = "打开 Antigravity";
            _btnLaunchAg.BackColor = Color.FromArgb(52, 47, 44);
            _btnLaunchAg.ForeColor = Color.FromArgb(244, 240, 234);
            _btnLaunchAg.FlatStyle = FlatStyle.Flat;
            _btnLaunchAg.FlatAppearance.BorderSize = 0;
            _btnLaunchAg.SetBounds(392, 416, 108, 34);
            _btnLaunchAg.Click += delegate { LaunchAntigravity(); };
            Controls.Add(_btnLaunchAg);

            _btnClose = new Button();
            _btnClose.Text = "关闭";
            _btnClose.BackColor = Color.FromArgb(44, 40, 38);
            _btnClose.ForeColor = Color.FromArgb(215, 208, 200);
            _btnClose.FlatStyle = FlatStyle.Flat;
            _btnClose.FlatAppearance.BorderSize = 0;
            _btnClose.SetBounds(508, 416, 48, 34);
            _btnClose.Click += delegate { Close(); };
            Controls.Add(_btnClose);

            RefreshStatusCard();
            if (_opts.Uninstall)
            {
                Shown += delegate { RunAction(true); };
            }
        }

        private void RefreshStatusCard()
        {
            Dictionary<string, object> st = InstallerCore.BuildStatusDictionary(_opts);
            bool installed = st.ContainsKey("installed") && st["installed"] is bool && (bool)st["installed"];
            bool enabled = st.ContainsKey("pluginEnabled") && st["pluginEnabled"] is bool && (bool)st["pluginEnabled"];
            string ver = st.ContainsKey("installedVersion") ? (st["installedVersion"] as string) : null;
            string agVer = st.ContainsKey("antigravityVersion") ? (st["antigravityVersion"] as string) : null;
            string installDir = st["installDir"] as string;
            string pluginDataDir = st["pluginDataDir"] as string;
            bool hasLegacy = st.ContainsKey("hasLegacyInstall") && st["hasLegacyInstall"] is bool && (bool)st["hasLegacyInstall"];

            _statusTitle.Text = installed
                ? "当前状态：已安装原生插件 v" + (string.IsNullOrEmpty(ver) ? "?" : ver) + (enabled ? "（已启用）" : "（未启用）")
                : "当前状态：尚未安装原生插件";

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("Antigravity：" + (!string.IsNullOrEmpty(agVer) ? "已检测到 " + agVer : "未在默认路径检测到（仍可离线部署插件）"));
            sb.AppendLine("插件路径：" + installDir);
            sb.AppendLine("配置目录：" + pluginDataDir);
            if (hasLegacy)
            {
                sb.AppendLine("迁移提示：检测到旧版外部安装/快捷方式，安装时将自动迁移配置并清理。");
            }
            _statusBody.Text = sb.ToString().Trim();
            _btnInstall.Text = installed ? "更新插件" : "安装插件";
            _btnUninstall.Enabled = installed;
            _btnLaunchAg.Enabled = st.ContainsKey("antigravityExe") && !string.IsNullOrEmpty(st["antigravityExe"] as string);
        }

        private void AppendLog(string text)
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action)(delegate { AppendLog(text); }));
                return;
            }
            if (!string.IsNullOrEmpty(_logBox.Text)) _logBox.AppendText(Environment.NewLine);
            _logBox.AppendText(text);
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            _btnInstall.Enabled = !busy;
            _btnUninstall.Enabled = !busy;
            _btnOpenDir.Enabled = !busy;
            _btnLaunchAg.Enabled = !busy;
        }

        private void RunAction(bool uninstall)
        {
            if (_busy) return;
            SetBusy(true);
            _progress.Value = 0;
            _logBox.Clear();
            AppendLog(uninstall ? "[*] 开始卸载原生插件..." : "[*] 开始安装原生插件...");

            Thread worker = new Thread(delegate()
            {
                try
                {
                    Action<int, string> onProgress = delegate(int pct, string msg)
                    {
                        BeginInvoke((Action)(delegate
                        {
                            _progress.Value = Math.Max(0, Math.Min(100, pct));
                            AppendLog("[" + pct + "%] " + msg);
                        }));
                    };
                    OperationResult res = uninstall
                        ? InstallerCore.RunUninstall(_opts, onProgress)
                        : InstallerCore.RunInstall(_opts, onProgress);

                    BeginInvoke((Action)(delegate
                    {
                        SetBusy(false);
                        RefreshStatusCard();
                        AppendLog("[✓] " + res.Headline);
                        AppendLog(res.Detail);
                        if (res.SelfDeleteScheduled)
                        {
                            InstallerCore.ScheduleSelfDeleteIfNeeded(res.InstallDir, res.PluginDataDir);
                        }
                        MessageBox.Show(res.Detail, res.Headline, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }));
                }
                catch (Exception ex)
                {
                    BeginInvoke((Action)(delegate
                    {
                        SetBusy(false);
                        RefreshStatusCard();
                        AppendLog("[✗] 操作失败: " + ex.Message);
                        MessageBox.Show(ex.Message, "AGY Claude Style 操作失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void OpenPluginDir()
        {
            string dir = string.IsNullOrEmpty(_opts.InstallDir)
                ? InstallerCore.GetDefaultInstallDir()
                : Path.GetFullPath(_opts.InstallDir);
            if (!Directory.Exists(dir)) dir = Path.GetDirectoryName(dir);
            if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
            {
                Process.Start("explorer.exe", "\"" + dir + "\"");
            }
        }

        private void LaunchAntigravity()
        {
            AntigravityDetectInfo ag = InstallerCore.DetectAntigravity();
            if (ag.Installed && !string.IsNullOrEmpty(ag.ExePath))
            {
                Process.Start(ag.ExePath);
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            InstallerOptions opts = ParseArgs(args);

            if (opts.StatusOnly)
            {
                Dictionary<string, object> st = InstallerCore.BuildStatusDictionary(opts);
                string json = MiniJson.Stringify(st, true);
                if (!string.IsNullOrEmpty(opts.OutFile))
                {
                    File.WriteAllText(opts.OutFile, json, new UTF8Encoding(false));
                }
                else
                {
                    Console.WriteLine(json);
                }
                return 0;
            }

            if (opts.Silent)
            {
                try
                {
                    OperationResult res = opts.Uninstall
                        ? InstallerCore.RunUninstall(opts, null)
                        : InstallerCore.RunInstall(opts, null);
                    WriteOutFile(opts.OutFile, res);
                    if (opts.Popup)
                    {
                        MessageBox.Show(res.Detail, res.Headline, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    if (res.SelfDeleteScheduled)
                    {
                        InstallerCore.ScheduleSelfDeleteIfNeeded(res.InstallDir, res.PluginDataDir);
                    }
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    if (!string.IsNullOrEmpty(opts.OutFile))
                    {
                        Dictionary<string, object> err = new Dictionary<string, object>(StringComparer.Ordinal);
                        err["ok"] = false;
                        err["error"] = ex.Message;
                        File.WriteAllText(opts.OutFile, MiniJson.Stringify(err, true), new UTF8Encoding(false));
                    }
                    if (opts.Popup)
                    {
                        MessageBox.Show(ex.Message, "AGY Claude Style 操作失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm(opts));
            return 0;
        }

        private static InstallerOptions ParseArgs(string[] args)
        {
            InstallerOptions opts = new InstallerOptions();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--uninstall") opts.Uninstall = true;
                else if (a == "--silent" || a == "/S" || a == "-s") opts.Silent = true;
                else if (a == "--popup") opts.Popup = true;
                else if (a == "--status") opts.StatusOnly = true;
                else if (a == "--install-dir" && i + 1 < args.Length) opts.InstallDir = args[++i];
                else if (a == "--out" && i + 1 < args.Length) opts.OutFile = args[++i];
            }
            return opts;
        }

        private static void WriteOutFile(string outFile, OperationResult res)
        {
            if (string.IsNullOrEmpty(outFile)) return;
            Dictionary<string, object> d = new Dictionary<string, object>(StringComparer.Ordinal);
            d["ok"] = res.Ok;
            d["mode"] = res.Mode;
            d["headline"] = res.Headline;
            d["detail"] = res.Detail;
            d["installDir"] = res.InstallDir;
            d["pluginDataDir"] = res.PluginDataDir;
            d["antigravityExe"] = res.AntigravityExe;
            d["antigravityVersion"] = res.AntigravityVersion;
            d["preservedExistingConfig"] = res.PreservedExistingConfig;
            d["migratedLegacyConfig"] = res.MigratedLegacyConfig;
            d["legacyCleaned"] = res.LegacyCleaned;
            d["pluginEnabled"] = res.PluginEnabled;
            d["lsHotReloaded"] = res.LsHotReloaded;
            d["fileCount"] = res.FileCount;
            d["selfDeleteScheduled"] = res.SelfDeleteScheduled;
            File.WriteAllText(outFile, MiniJson.Stringify(d, true), new UTF8Encoding(false));
        }
    }
}
