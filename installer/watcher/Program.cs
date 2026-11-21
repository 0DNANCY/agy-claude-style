using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AgyClaudeStyle.Watcher
{
    internal class AttachedEntry
    {
        public CdpSession Session;
        public string BootstrapScriptId;
        public string ConfigScriptId;
        public string Title;
    }

    internal static class Program
    {
        private static readonly object LogLock = new object();
        private static string _baseDir;
        private static string _logFile;
        private static string _pidFile;
        private static bool _isWatch;

        [STAThread]
        private static int Main(string[] args)
        {
            string mode = "watch";
            string customDir = null;
            int? overridePort = null;
            string outFile = null;
            bool exitOnHostCloseFlag = false;
            int? parentPid = null;

            string envPpid = Environment.GetEnvironmentVariable("AG_PARENT_PID");
            if (!string.IsNullOrEmpty(envPpid))
            {
                int parsedPpid;
                if (int.TryParse(envPpid.Trim(), out parsedPpid) && parsedPpid > 0) parentPid = parsedPpid;
            }

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--watch") mode = "watch";
                else if (a == "--once") mode = "once";
                else if (a == "--remove") mode = "remove";
                else if (a == "--exit-on-host-close") exitOnHostCloseFlag = true;
                else if (a == "--parent-pid" && i + 1 < args.Length)
                {
                    int pp;
                    if (int.TryParse(args[++i], out pp) && pp > 0) parentPid = pp;
                }
                else if (a == "--dir" && i + 1 < args.Length) customDir = args[++i];
                else if (a == "--cdp-port" && i + 1 < args.Length)
                {
                    int p;
                    if (int.TryParse(args[++i], out p) && p > 0) overridePort = p;
                }
                else if (a == "--out" && i + 1 < args.Length) outFile = args[++i];
            }

            _baseDir = Path.GetFullPath(string.IsNullOrEmpty(customDir) ? AppDomain.CurrentDomain.BaseDirectory : customDir).TrimEnd('\\', '/');
            _logFile = Path.Combine(_baseDir, "watch.log");
            _pidFile = Path.Combine(_baseDir, ".watch.pid");
            _isWatch = (mode == "watch");

            try
            {
                if (mode == "once")
                {
                    return RunOnceAsync(overridePort, outFile).GetAwaiter().GetResult();
                }
                if (mode == "remove")
                {
                    return RunRemoveAsync(overridePort, outFile).GetAwaiter().GetResult();
                }
                return RunWatchAsync(overridePort, exitOnHostCloseFlag, parentPid).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Log("[!] Fatal error: " + ex.Message);
                WriteResult(outFile, false, ex.Message, null);
                return 1;
            }
        }

        private static void Log(string line)
        {
            if (!_isWatch) return;
            lock (LogLock)
            {
                try
                {
                    FileInfo fi = new FileInfo(_logFile);
                    if (fi.Exists && fi.Length > 1024 * 1024)
                    {
                        File.WriteAllText(_logFile, "", new UTF8Encoding(false));
                    }
                    string entry = string.Format("[{0}] {1}\n", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), line);
                    byte[] bytes = new UTF8Encoding(false).GetBytes(entry);
                    using (FileStream fs = new FileStream(_logFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                    {
                        fs.Write(bytes, 0, bytes.Length);
                    }
                }
                catch { }
            }
        }

        private static void WriteResult(string outFile, bool ok, string message, List<string> pages)
        {
            if (string.IsNullOrEmpty(outFile)) return;
            try
            {
                Dictionary<string, object> res = new Dictionary<string, object>(StringComparer.Ordinal);
                res["ok"] = ok;
                res["message"] = message ?? "";
                if (pages != null) res["pages"] = pages;
                File.WriteAllText(outFile, MiniJson.Stringify(res, true), new UTF8Encoding(false));
            }
            catch { }
        }

        public static string GetDirHash(string dir)
        {
            return CdpHelper.ComputeHash(Path.GetFullPath(dir).TrimEnd('\\', '/').ToLowerInvariant());
        }

        private static int? ReadPidFile()
        {
            try
            {
                if (!File.Exists(_pidFile)) return null;
                int pid;
                if (int.TryParse(File.ReadAllText(_pidFile, Encoding.UTF8).Trim(), out pid) && pid > 0) return pid;
            }
            catch { }
            return null;
        }

        private static void ReleasePidFile(int selfPid)
        {
            try
            {
                int? current = ReadPidFile();
                if (current.HasValue && current.Value == selfPid)
                {
                    File.Delete(_pidFile);
                }
            }
            catch { }
        }

        private static async Task<int> RunOnceAsync(int? overridePort, string outFile)
        {
            PluginManifest manifest = PluginManifest.Load(_baseDir);
            int? port = CdpHelper.ReadPort(overridePort);
            if (!port.HasValue)
            {
                bool running = CdpHelper.GetAntigravityProcessIds().Count > 0;
                WriteResult(outFile, false, CdpHelper.CdpUnavailableMessage(running, null), null);
                return 1;
            }

            List<CdpPageInfo> pages;
            try
            {
                pages = await CdpHelper.ListPagesAsync(port.Value).ConfigureAwait(false);
            }
            catch
            {
                bool running = CdpHelper.GetAntigravityProcessIds().Count > 0;
                WriteResult(outFile, false, CdpHelper.CdpUnavailableMessage(running, port), null);
                return 1;
            }
            if (pages.Count == 0)
            {
                WriteResult(outFile, false, "未找到 Antigravity 窗口页面", null);
                return 1;
            }

            string expr = CdpHelper.BuildInjectExpression(_baseDir, manifest);
            List<string> injectedTitles = new List<string>();
            for (int i = 0; i < pages.Count; i++)
            {
                CdpPageInfo page = pages[i];
                using (CdpSession session = await CdpSession.ConnectAsync(page.WebSocketDebuggerUrl, 4000).ConfigureAwait(false))
                {
                    await session.EvaluateAsync(expr, false).ConfigureAwait(false);
                    injectedTitles.Add(CdpHelper.ShortTitle(page));
                }
            }
            WriteResult(outFile, true, "injected " + injectedTitles.Count + " page(s)", injectedTitles);
            return 0;
        }

        private static async Task<int> RunRemoveAsync(int? overridePort, string outFile)
        {
            PluginManifest manifest = PluginManifest.Load(_baseDir);
            StopRunningWatcherInDir(_baseDir);

            int? port = CdpHelper.ReadPort(overridePort);
            List<string> cleaned = new List<string>();
            if (port.HasValue)
            {
                try
                {
                    List<CdpPageInfo> pages = await CdpHelper.ListPagesAsync(port.Value).ConfigureAwait(false);
                    for (int i = 0; i < pages.Count; i++)
                    {
                        CdpPageInfo page = pages[i];
                        try
                        {
                            using (CdpSession session = await CdpSession.ConnectAsync(page.WebSocketDebuggerUrl, 3000).ConfigureAwait(false))
                            {
                                await session.EvaluateAsync(manifest.RemoveExpression, false).ConfigureAwait(false);
                                cleaned.Add(CdpHelper.ShortTitle(page));
                            }
                        }
                        catch { }
                    }
                }
                catch { }
            }
            WriteResult(outFile, true, "removed from " + cleaned.Count + " page(s)", cleaned);
            return 0;
        }

        private static void StopRunningWatcherInDir(string dir)
        {
            string pidFile = Path.Combine(dir, ".watch.pid");
            int? pid = null;
            try
            {
                if (File.Exists(pidFile))
                {
                    int p;
                    if (int.TryParse(File.ReadAllText(pidFile, Encoding.UTF8).Trim(), out p) && p > 0) pid = p;
                }
            }
            catch { }

            int selfPid = Process.GetCurrentProcess().Id;
            if (pid.HasValue && pid.Value != selfPid)
            {
                CdpHelper.WatcherPidClassification cls = CdpHelper.ClassifyWatcherPid(pid.Value, dir);
                if (cls.Status == CdpHelper.WatcherPidStatus.Unknown)
                {
                    // Fail closed: cannot verify process ownership, refuse to signal/kill or delete .watch.pid.
                    return;
                }
                if (cls.Status == CdpHelper.WatcherPidStatus.Dead || cls.Status == CdpHelper.WatcherPidStatus.Foreign)
                {
                    try { if (File.Exists(pidFile)) File.Delete(pidFile); } catch { }
                    return;
                }

                string hash = GetDirHash(dir);
                try
                {
                    using (EventWaitHandle stopEvt = EventWaitHandle.OpenExisting("Local\\AGYClaudeStyleStop_" + hash))
                    {
                        stopEvt.Set();
                    }
                }
                catch { }

                try
                {
                    Process proc = Process.GetProcessById(pid.Value);
                    if (!proc.WaitForExit(1500))
                    {
                        proc.Kill();
                        proc.WaitForExit(1500);
                    }
                }
                catch { }
            }
            try { if (File.Exists(pidFile)) File.Delete(pidFile); } catch { }
        }

        private static bool GetConfigBool(Dictionary<string, object> cfg, string key)
        {
            object v;
            if (cfg != null && cfg.TryGetValue(key, out v) && v is bool)
            {
                return (bool)v;
            }
            return false;
        }

        private static async Task<int> RunWatchAsync(int? overridePort, bool exitOnHostCloseFlag, int? parentPid)
        {
            string dirHash = GetDirHash(_baseDir);
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\AGYClaudeStyleWatcher_" + dirHash, out createdNew))
            {
                if (!createdNew)
                {
                    return 0;
                }

                int selfPid = Process.GetCurrentProcess().Id;
                int? existingPid = ReadPidFile();
                if (existingPid.HasValue && existingPid.Value != selfPid)
                {
                    CdpHelper.WatcherPidClassification cls = CdpHelper.ClassifyWatcherPid(existingPid.Value, _baseDir);
                    if (cls.Status == CdpHelper.WatcherPidStatus.Unknown)
                    {
                        Log(string.Format("[!] 无法验证 .watch.pid 进程归属 (PID {0})，出于安全策略拒绝覆盖锁文件", existingPid.Value));
                        return 1;
                    }
                    if (cls.Status == CdpHelper.WatcherPidStatus.Owned)
                    {
                        Log(string.Format("[*] 检测到同目录守护进程已在运行 (PID {0})，退出重复实例", existingPid.Value));
                        return 0;
                    }
                }

                File.WriteAllText(_pidFile, selfPid.ToString(), new UTF8Encoding(false));
                try { File.WriteAllText(_logFile, "", new UTF8Encoding(false)); } catch { }

                PluginManifest manifest = PluginManifest.Load(_baseDir);
                Dictionary<string, object> initCfg = CdpHelper.ReadConfig(_baseDir, manifest);
                bool cfgAutoRelaunch = GetConfigBool(initCfg, "autoRelaunchWithCdp");
                bool cfgExitOnHostClose = GetConfigBool(initCfg, "exitOnHostClose");
                Log(string.Format("[*] AGY Claude Style (agy-claude-style) 守护模式启动 (PID {0})，每 2 秒检查一次窗口", selfPid));

                string currentCodeHash;
                string currentCssHash;
                CdpHelper.ReadBundleAndCssHashes(_baseDir, manifest, out currentCodeHash, out currentCssHash);
                string currentExpr = CdpHelper.BuildInjectExpression(_baseDir, manifest);
                string currentConfigExpr = CdpHelper.BuildConfigScriptExpression(_baseDir, manifest, currentCodeHash);
                object exprLock = new object();
                bool hadAttachedWindow = false;
                ConcurrentDictionary<string, AttachedEntry> attached = new ConcurrentDictionary<string, AttachedEntry>(StringComparer.Ordinal);
                ManualResetEventSlim exitEvent = new ManualResetEventSlim(false);
                EventWaitHandle stopSignal = new EventWaitHandle(false, EventResetMode.ManualReset, "Local\\AGYClaudeStyleStop_" + dirHash);

                ThreadPool.RegisterWaitForSingleObject(stopSignal, (state, timedOut) =>
                {
                    exitEvent.Set();
                }, null, -1, true);

                AppDomain.CurrentDomain.ProcessExit += (s, e) =>
                {
                    exitEvent.Set();
                    ReleasePidFile(selfPid);
                };

                Func<AttachedEntry, string, string, bool, Task<Dictionary<string, object>>> applyAsync = async (entry, fullExprToUse, configExprToUse, refreshOnly) =>
                {
                    if (refreshOnly && !string.IsNullOrEmpty(entry.BootstrapScriptId) && !string.IsNullOrEmpty(configExprToUse))
                    {
                        if (!string.IsNullOrEmpty(entry.ConfigScriptId))
                        {
                            try
                            {
                                Dictionary<string, object> rmCfg = new Dictionary<string, object>(StringComparer.Ordinal);
                                rmCfg["identifier"] = entry.ConfigScriptId;
                                await entry.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", rmCfg, 5000).ConfigureAwait(false);
                            }
                            catch { }
                            entry.ConfigScriptId = null;
                        }
                        Dictionary<string, object> addCfgParams = new Dictionary<string, object>(StringComparer.Ordinal);
                        addCfgParams["source"] = configExprToUse;
                        Dictionary<string, object> addCfgRes = await entry.Session.SendAsync("Page.addScriptToEvaluateOnNewDocument", addCfgParams, 15000).ConfigureAwait(false);
                        object cfgIdVal;
                        if (addCfgRes.TryGetValue("identifier", out cfgIdVal)) entry.ConfigScriptId = cfgIdVal as string;

                        try
                        {
                            object fastVal = await entry.Session.EvaluateAsync(configExprToUse, false).ConfigureAwait(false);
                            Dictionary<string, object> fastDict = fastVal as Dictionary<string, object>;
                            object stObj;
                            if (fastDict != null && fastDict.TryGetValue("status", out stObj) && string.Equals(stObj as string, "refreshed", StringComparison.Ordinal))
                            {
                                return fastDict;
                            }
                        }
                        catch { }
                    }

                    if (!string.IsNullOrEmpty(entry.ConfigScriptId))
                    {
                        try
                        {
                            Dictionary<string, object> rmCfg = new Dictionary<string, object>(StringComparer.Ordinal);
                            rmCfg["identifier"] = entry.ConfigScriptId;
                            await entry.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", rmCfg, 5000).ConfigureAwait(false);
                        }
                        catch { }
                        entry.ConfigScriptId = null;
                    }
                    if (!string.IsNullOrEmpty(entry.BootstrapScriptId))
                    {
                        try
                        {
                            Dictionary<string, object> rmBoot = new Dictionary<string, object>(StringComparer.Ordinal);
                            rmBoot["identifier"] = entry.BootstrapScriptId;
                            await entry.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", rmBoot, 5000).ConfigureAwait(false);
                        }
                        catch { }
                        entry.BootstrapScriptId = null;
                    }
                    Dictionary<string, object> addBootParams = new Dictionary<string, object>(StringComparer.Ordinal);
                    addBootParams["source"] = fullExprToUse;
                    Dictionary<string, object> addBootRes = await entry.Session.SendAsync("Page.addScriptToEvaluateOnNewDocument", addBootParams, 15000).ConfigureAwait(false);
                    object bootIdVal;
                    if (addBootRes.TryGetValue("identifier", out bootIdVal)) entry.BootstrapScriptId = bootIdVal as string;

                    if (!string.IsNullOrEmpty(configExprToUse))
                    {
                        Dictionary<string, object> addCfgParams = new Dictionary<string, object>(StringComparer.Ordinal);
                        addCfgParams["source"] = configExprToUse;
                        Dictionary<string, object> addCfgRes = await entry.Session.SendAsync("Page.addScriptToEvaluateOnNewDocument", addCfgParams, 15000).ConfigureAwait(false);
                        object cfgIdVal;
                        if (addCfgRes.TryGetValue("identifier", out cfgIdVal)) entry.ConfigScriptId = cfgIdVal as string;
                        try
                        {
                            await entry.Session.EvaluateAsync(configExprToUse, false).ConfigureAwait(false);
                        }
                        catch { }
                    }

                    object evalVal = await entry.Session.EvaluateAsync(fullExprToUse, false).ConfigureAwait(false);
                    return evalVal as Dictionary<string, object>;
                };

                Func<CdpPageInfo, Task> attachAsync = async (page) =>
                {
                    if (!attached.TryAdd(page.Id, null)) return;
                    CdpSession session = null;
                    try
                    {
                        session = await CdpSession.ConnectAsync(page.WebSocketDebuggerUrl, 4000).ConfigureAwait(false);
                        AttachedEntry entry = new AttachedEntry();
                        entry.Session = session;
                        entry.BootstrapScriptId = null;
                        entry.ConfigScriptId = null;
                        entry.Title = CdpHelper.ShortTitle(page);
                        attached[page.Id] = entry;

                        session.OnClose = () =>
                        {
                            AttachedEntry ignored;
                            attached.TryRemove(page.Id, out ignored);
                            Log("[-] 窗口已关闭: " + entry.Title);
                        };

                        await session.SendAsync("Page.enable", null, 5000).ConfigureAwait(false);
                        session.On("Runtime.bindingCalled", (p) =>
                        {
                            object bNameObj;
                            object payloadObj;
                            if (!p.TryGetValue("name", out bNameObj) || !string.Equals(bNameObj as string, manifest.SettingBinding, StringComparison.Ordinal)) return;
                            if (!p.TryGetValue("payload", out payloadObj) || !(payloadObj is string)) return;
                            try
                            {
                                Dictionary<string, object> kv = MiniJson.ParseObject((string)payloadObj);
                                object kObj;
                                object vObj;
                                if (kv.TryGetValue("key", out kObj) && kObj is string && kv.TryGetValue("value", out vObj))
                                {
                                    string key = (string)kObj;
                                    if (CdpHelper.UpdateConfigSetting(_baseDir, manifest, key, vObj))
                                    {
                                        Log("[⚙] 设置已保存: " + key + " = " + MiniJson.Stringify(vObj, false));
                                    }
                                }
                            }
                            catch { }
                        });

                        await session.SendAsync("Runtime.enable", null, 5000).ConfigureAwait(false);
                        Dictionary<string, object> bindParams = new Dictionary<string, object>(StringComparer.Ordinal);
                        bindParams["name"] = manifest.SettingBinding;
                        await session.SendAsync("Runtime.addBinding", bindParams, 5000).ConfigureAwait(false);

                        string exprSnapshot;
                        string cfgExprSnapshot;
                        lock (exprLock)
                        {
                            exprSnapshot = currentExpr;
                            cfgExprSnapshot = currentConfigExpr;
                        }
                        Dictionary<string, object> res = await applyAsync(entry, exprSnapshot, cfgExprSnapshot, false).ConfigureAwait(false);
                        string status = (res != null && res.ContainsKey("status")) ? Convert.ToString(res["status"]) : "ok";
                        lock (exprLock) { hadAttachedWindow = true; }
                        Log(string.Format("[✓] 已注入 agy-claude-style: {0} ({1})", entry.Title, status));
                    }
                    catch (Exception ex)
                    {
                        AttachedEntry removed;
                        if (attached.TryRemove(page.Id, out removed) && removed != null && removed.Session != null)
                        {
                            try { removed.Session.Close(); } catch { }
                        }
                        if (session != null)
                        {
                            try { session.Close(); } catch { }
                        }
                        Log(string.Format("[!] 注入失败，稍后重试: {0} — {1}", CdpHelper.ShortTitle(page), ex.Message));
                    }
                };

                Timer reloadTimer = null;
                string pendingFilename = null;
                object timerLock = new object();

                FileSystemWatcher fsw = null;
                try
                {
                    fsw = new FileSystemWatcher(_baseDir);
                    fsw.IncludeSubdirectories = false;
                    fsw.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.CreationTime;
                    FileSystemEventHandler onFsChange = (sender, e) =>
                    {
                        string name = e.Name;
                        if (string.IsNullOrEmpty(name) || name.StartsWith(".", StringComparison.Ordinal)) return;
                        if (!name.EndsWith(".css", StringComparison.OrdinalIgnoreCase) &&
                            !name.EndsWith(".js", StringComparison.OrdinalIgnoreCase) &&
                            !name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                        {
                            return;
                        }
                        lock (timerLock)
                        {
                            pendingFilename = name;
                            if (reloadTimer == null)
                            {
                                reloadTimer = new Timer(async (_) =>
                                {
                                    string changedName;
                                    lock (timerLock) { changedName = pendingFilename; }
                                    try
                                    {
                                        manifest = PluginManifest.Load(_baseDir);
                                        Dictionary<string, object> nextCfg = CdpHelper.ReadConfig(_baseDir, manifest);
                                        string nextCodeHash;
                                        string nextCssHash;
                                        CdpHelper.ReadBundleAndCssHashes(_baseDir, manifest, out nextCodeHash, out nextCssHash);
                                        bool refreshOnly;
                                        string nextExpr;
                                        lock (exprLock)
                                        {
                                            refreshOnly = !string.IsNullOrEmpty(currentCodeHash) &&
                                                string.Equals(nextCodeHash, currentCodeHash, StringComparison.Ordinal) &&
                                                string.Equals(nextCssHash, currentCssHash, StringComparison.Ordinal);
                                            nextExpr = refreshOnly ? currentExpr : CdpHelper.BuildInjectExpression(_baseDir, manifest);
                                            currentCodeHash = nextCodeHash;
                                            currentCssHash = nextCssHash;
                                            currentExpr = nextExpr;
                                        }
                                        string nextConfigExpr = CdpHelper.BuildConfigScriptExpression(_baseDir, manifest, nextCodeHash);
                                        lock (exprLock)
                                        {
                                            currentConfigExpr = nextConfigExpr;
                                            cfgAutoRelaunch = GetConfigBool(nextCfg, "autoRelaunchWithCdp");
                                            cfgExitOnHostClose = GetConfigBool(nextCfg, "exitOnHostClose");
                                        }

                                        int n = 0;
                                        foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                                        {
                                            AttachedEntry entry = kv.Value;
                                            if (entry == null) continue;
                                            try
                                            {
                                                await applyAsync(entry, nextExpr, nextConfigExpr, refreshOnly).ConfigureAwait(false);
                                                n++;
                                            }
                                            catch { }
                                        }
                                        Log(string.Format("[↻] {0} 已变更，已热更新 {1} 个窗口{2}", changedName, n, refreshOnly ? "（轻量配置同步）" : ""));
                                    }
                                    catch (Exception ex)
                                    {
                                        Log("[!] 读取文件失败: " + ex.Message);
                                    }
                                }, null, 180, Timeout.Infinite);
                            }
                            else
                            {
                                reloadTimer.Change(180, Timeout.Infinite);
                            }
                        }
                    };
                    fsw.Changed += onFsChange;
                    fsw.Created += onFsChange;
                    fsw.Renamed += (s, e) => onFsChange(s, e);
                    fsw.EnableRaisingEvents = true;
                }
                catch { }

                bool isExplicitPort = overridePort.HasValue || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("AG_CDP_PORT"));
                int? lastPort = null;
                int consecutivePortFailures = 0;
                int noCdpRunningTicks = 0;
                string warnedNoCdpSig = "";
                string relaunchedPidSig = "";
                DateTime lastRelaunchUtc = DateTime.MinValue;
                string cdpFlagCheckedSig = "";
                bool cdpFlagCheckedVal = false;

                try
                {
                    while (!exitEvent.IsSet)
                    {
                        if (parentPid.HasValue && !CdpHelper.IsProcessAlive(parentPid.Value))
                        {
                            Log("[*] 父进程 " + parentPid.Value + " 已退出，守护进程自动停止");
                            break;
                        }

                        int sleepMs = 2000;
                        try
                        {
                            int? port = CdpHelper.ReadPort(overridePort);
                            List<CdpPageInfo> pages = null;
                            if (port.HasValue)
                            {
                                try
                                {
                                    pages = await CdpHelper.ListPagesAsync(port.Value).ConfigureAwait(false);
                                }
                                catch
                                {
                                    pages = null;
                                }
                            }

                            if (port.HasValue && pages != null)
                            {
                                consecutivePortFailures = 0;
                                noCdpRunningTicks = 0;
                                warnedNoCdpSig = "";
                                cdpFlagCheckedSig = "";
                                cdpFlagCheckedVal = false;

                                if (!lastPort.HasValue || lastPort.Value != port.Value)
                                {
                                    // Close stale sessions if Antigravity restarted on a new port
                                    foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                                    {
                                        AttachedEntry oldEntry;
                                        if (attached.TryRemove(kv.Key, out oldEntry) && oldEntry != null && oldEntry.Session != null)
                                        {
                                            try { oldEntry.Session.Close(); } catch { }
                                        }
                                    }
                                    Log("[+] 连接到调试端口 " + port.Value);
                                    lastPort = port.Value;
                                }

                                List<Task> tasks = new List<Task>();
                                for (int i = 0; i < pages.Count; i++)
                                {
                                    if (!attached.ContainsKey(pages[i].Id))
                                    {
                                        tasks.Add(attachAsync(pages[i]));
                                    }
                                }
                                if (tasks.Count > 0)
                                {
                                    await Task.WhenAll(tasks).ConfigureAwait(false);
                                }
                            }
                            else
                            {
                                consecutivePortFailures++;
                                if (consecutivePortFailures >= 3)
                                {
                                    foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                                    {
                                        AttachedEntry oldEntry;
                                        if (attached.TryRemove(kv.Key, out oldEntry) && oldEntry != null && oldEntry.Session != null)
                                        {
                                            try { oldEntry.Session.Close(); } catch { }
                                        }
                                    }
                                    lastPort = null;
                                }

                                bool hadWin;
                                bool autoRelaunch;
                                bool exitOnClose;
                                lock (exprLock)
                                {
                                    hadWin = hadAttachedWindow;
                                    autoRelaunch = cfgAutoRelaunch;
                                    exitOnClose = exitOnHostCloseFlag || cfgExitOnHostClose;
                                }

                                List<int> runningPids = isExplicitPort ? new List<int>() : CdpHelper.GetAntigravityProcessIds();
                                if (exitOnClose && hadWin && attached.IsEmpty && consecutivePortFailures >= 3 && runningPids.Count == 0)
                                {
                                    Log("[*] Antigravity 宿主已关闭，守护进程自动退出");
                                    break;
                                }

                                if (runningPids.Count > 0)
                                {
                                    noCdpRunningTicks++;
                                    string pidSig = string.Join(",", runningPids);
                                    if (noCdpRunningTicks >= 3)
                                    {
                                        if (cdpFlagCheckedSig != pidSig)
                                        {
                                            cdpFlagCheckedSig = pidSig;
                                            cdpFlagCheckedVal = CdpHelper.HasAntigravityCdpFlag();
                                        }
                                        if (cdpFlagCheckedVal)
                                        {
                                            if (warnedNoCdpSig != "cdp:" + pidSig)
                                            {
                                                warnedNoCdpSig = "cdp:" + pidSig;
                                                Log("[*] 检测到 Antigravity 已携带 --remote-debugging-port 参数，继续等待调试端口响应...");
                                            }
                                        }
                                        else
                                        {
                                            if (warnedNoCdpSig != pidSig)
                                            {
                                                warnedNoCdpSig = pidSig;
                                                Log("[!] " + CdpHelper.CdpUnavailableMessage(true, port));
                                                if (!autoRelaunch)
                                                {
                                                    Log("[*] 提示：可在 config.json 中设置 \"autoRelaunchWithCdp\": true 以启用自动温和重启接管");
                                                }
                                            }
                                            if (autoRelaunch && relaunchedPidSig != pidSig &&
                                                (DateTime.UtcNow - lastRelaunchUtc).TotalSeconds >= 60.0)
                                            {
                                                relaunchedPidSig = pidSig;
                                                lastRelaunchUtc = DateTime.UtcNow;
                                                Log("[↻] autoRelaunchWithCdp 已启用：正在温和重启 Antigravity 并附加 --remote-debugging-port=0 ...");
                                                bool ok = CdpHelper.RelaunchAntigravityWithCdp(null, 0, 8000);
                                                if (ok)
                                                {
                                                    Log("[✓] 已以 CDP 模式重启 Antigravity，等待窗口就绪...");
                                                    noCdpRunningTicks = 0;
                                                    cdpFlagCheckedSig = "";
                                                    cdpFlagCheckedVal = false;
                                                }
                                                else
                                                {
                                                    Log("[!] 自动重启未完成，请手动完全退出 Antigravity 后以 --remote-debugging-port=0 启动");
                                                }
                                            }
                                        }
                                    }
                                }
                                else
                                {
                                    noCdpRunningTicks = 0;
                                    warnedNoCdpSig = "";
                                    cdpFlagCheckedSig = "";
                                    cdpFlagCheckedVal = false;
                                    if (consecutivePortFailures >= 3)
                                    {
                                        sleepMs = 5000;
                                    }
                                }
                            }
                        }
                        catch { }

                        exitEvent.Wait(sleepMs);
                    }
                }
                finally
                {
                    if (fsw != null) { try { fsw.Dispose(); } catch { } }
                    if (reloadTimer != null) { try { reloadTimer.Dispose(); } catch { } }
                    foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                    {
                        if (kv.Value != null && kv.Value.Session != null)
                        {
                            try { kv.Value.Session.Close(); } catch { }
                        }
                    }
                    try { stopSignal.Dispose(); } catch { }
                    try { exitEvent.Dispose(); } catch { }
                    ReleasePidFile(selfPid);
                }
            }
            return 0;
        }
    }
}
