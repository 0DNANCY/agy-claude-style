import Cocoa
import Foundation

struct InstallerOptions {
    var uninstall: Bool = false
    var silent: Bool = false
    var popup: Bool = false
    var statusOnly: Bool = false
    var installDir: String?
    var outFile: String?
}

struct AntigravityDetectInfo {
    var appPath: String?
    var version: String?
    var installed: Bool = false
}

struct LsDaemonInfo {
    var pid: Int32
    var httpPort: Int
    var csrfToken: String
}

struct OperationResult {
    var ok: Bool
    var mode: String
    var headline: String
    var detail: String
    var installDir: String
    var pluginDataDir: String
    var antigravityApp: String?
    var antigravityVersion: String?
    var preservedExistingConfig: Bool
    var migratedLegacyConfig: Bool
    var legacyCleaned: Bool
    var pluginEnabled: Bool
    var lsHotReloaded: Bool
    var fileCount: Int
    var selfDeleteScheduled: Bool
}

enum InstallerCore {
    static let pluginName = "agy-claude-style"
    static let sidecarName = "agy-claude-style/panel"
    static let legacyLaunchAgentLabel = "io.github.0dnancy.agy-claude-style"

    static func getTestSystemRoot() -> String? {
        guard let raw = ProcessInfo.processInfo.environment["AGY_CS_TEST_SYSTEM_ROOT"],
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return URL(fileURLWithPath: raw.trimmingCharacters(in: .whitespacesAndNewlines)).standardizedFileURL.path
    }

    static func isTestSandbox() -> Bool {
        return getTestSystemRoot() != nil
    }

    static func resolveGeminiDir() -> String {
        if let testRoot = getTestSystemRoot() {
            return (testRoot as NSString).appendingPathComponent(".gemini")
        }
        if let envDir = ProcessInfo.processInfo.environment["ANTIGRAVITY_GEMINI_DIR"],
           !envDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: envDir.trimmingCharacters(in: .whitespacesAndNewlines)).standardizedFileURL.path
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return (home as NSString).appendingPathComponent(".gemini")
    }

    static func defaultInstallDir() -> String {
        let gemini = resolveGeminiDir() as NSString
        let configDir = gemini.appendingPathComponent("config") as NSString
        let pluginsDir = configDir.appendingPathComponent("plugins") as NSString
        return pluginsDir.appendingPathComponent(pluginName)
    }

    static func pluginDataDir() -> String {
        let gemini = resolveGeminiDir() as NSString
        let agDir = gemini.appendingPathComponent("antigravity") as NSString
        let dataRoot = agDir.appendingPathComponent("plugin_data") as NSString
        return dataRoot.appendingPathComponent(pluginName)
    }

    static func antigravityConfigPath() -> String {
        let gemini = resolveGeminiDir() as NSString
        let configDir = gemini.appendingPathComponent("config") as NSString
        return configDir.appendingPathComponent("config.json")
    }

    static func legacyInstallDir() -> String {
        if let testRoot = getTestSystemRoot() {
            let base = (testRoot as NSString).appendingPathComponent("LegacyAppSupport") as NSString
            return base.appendingPathComponent(pluginName)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path as NSString
        let lib = home.appendingPathComponent("Library") as NSString
        let appSupport = lib.appendingPathComponent("Application Support") as NSString
        return appSupport.appendingPathComponent(pluginName)
    }

    static func legacyLaunchAgentPlistPath() -> String {
        if let testRoot = getTestSystemRoot() {
            let dir = (testRoot as NSString).appendingPathComponent("LaunchAgents") as NSString
            return dir.appendingPathComponent(legacyLaunchAgentLabel + ".plist")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path as NSString
        let lib = home.appendingPathComponent("Library") as NSString
        let dir = lib.appendingPathComponent("LaunchAgents") as NSString
        return dir.appendingPathComponent(legacyLaunchAgentLabel + ".plist")
    }

    static func legacyLauncherAppPath() -> String {
        if let testRoot = getTestSystemRoot() {
            let dir = (testRoot as NSString).appendingPathComponent("Applications") as NSString
            return dir.appendingPathComponent("Antigravity (AGY Claude Style).app")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path as NSString
        let dir = home.appendingPathComponent("Applications") as NSString
        return dir.appendingPathComponent("Antigravity (AGY Claude Style).app")
    }

    static func detectAntigravity() -> AntigravityDetectInfo {
        var info = AntigravityDetectInfo()
        let home = FileManager.default.homeDirectoryForCurrentUser.path as NSString
        let candidates = [
            "/Applications/Antigravity.app",
            (home.appendingPathComponent("Applications") as NSString).appendingPathComponent("Antigravity.app"),
        ]
        let fm = FileManager.default
        for c in candidates {
            let plistPath = ((c as NSString).appendingPathComponent("Contents") as NSString).appendingPathComponent("Info.plist")
            if fm.fileExists(atPath: c) {
                info.appPath = c
                info.installed = true
                if let dict = NSDictionary(contentsOfFile: plistPath) {
                    if let shortVer = dict["CFBundleShortVersionString"] as? String {
                        info.version = shortVer
                    } else if let ver = dict["CFBundleVersion"] as? String {
                        info.version = ver
                    }
                }
                break
            }
        }
        return info
    }

    private static func isPidAlive(_ pid: Int32) -> Bool {
        if pid <= 0 { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    static func discoverRunningLanguageServers() -> [LsDaemonInfo] {
        if isTestSandbox() { return [] }
        let fm = FileManager.default
        let agDir = (resolveGeminiDir() as NSString).appendingPathComponent("antigravity") as NSString
        let daemonDir = agDir.appendingPathComponent("daemon")
        guard let entries = try? fm.contentsOfDirectory(atPath: daemonDir) else { return [] }
        var result: [LsDaemonInfo] = []
        for name in entries where name.hasSuffix(".json") {
            let filePath = (daemonDir as NSString).appendingPathComponent(name)
            guard let raw = try? String(contentsOfFile: filePath, encoding: .utf8),
                  let obj = try? MiniJson.parseObject(raw) else { continue }
            guard let pidVal = obj["pid"]?.intValue,
                  let portVal = obj["httpPort"]?.intValue,
                  let csrf = obj["csrfToken"]?.stringValue,
                  pidVal > 0, portVal > 0, !csrf.isEmpty else { continue }
            let pid32 = Int32(pidVal)
            if isPidAlive(pid32) {
                result.append(LsDaemonInfo(pid: pid32, httpPort: portVal, csrfToken: csrf))
            }
        }
        return result
    }

    private static func callLsRpc(_ daemon: LsDaemonInfo, method: String, body: JsonValue, timeoutSec: TimeInterval = 2.5) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(daemon.httpPort)/exa.language_server_pb.LanguageServerService/\(method)") else {
            return false
        }
        var req = URLRequest(url: url, timeoutInterval: timeoutSec)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
        req.setValue(daemon.csrfToken, forHTTPHeaderField: "x-codeium-csrf-token")
        req.setValue(daemon.csrfToken, forHTTPHeaderField: "x-antigravity-csrf-token")
        let payload = MiniJson.stringify(body, pretty: false)
        req.httpBody = payload.data(using: .utf8)

        let sem = DispatchSemaphore(value: 0)
        var ok = false
        let task = URLSession.shared.dataTask(with: req) { _, response, error in
            if error == nil, let http = response as? HTTPURLResponse {
                ok = http.statusCode >= 200 && http.statusCode < 300
            }
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + timeoutSec + 0.5)
        return ok
    }

    private static func trySetLsPluginState(_ daemons: [LsDaemonInfo], enabled: Bool) -> Bool {
        if daemons.isEmpty { return false }
        let body: JsonValue = .object([
            "plugins": .object([pluginName: .object(["enabled": .bool(enabled)])]),
            "sidecars": .object([sidecarName: .object(["enabled": .bool(enabled)])]),
        ])
        var anyOk = false
        for d in daemons {
            if callLsRpc(d, method: "JetboxWriteState", body: body) {
                anyOk = true
            }
        }
        return anyOk
    }

    private static func tryDeleteLsPlugin(_ daemons: [LsDaemonInfo]) -> Bool {
        if daemons.isEmpty { return false }
        let body: JsonValue = .object(["pluginName": .string(pluginName)])
        var anyOk = false
        for d in daemons {
            if callLsRpc(d, method: "DeletePlugin", body: body) {
                anyOk = true
            }
        }
        return anyOk
    }

    static func readPluginEnabledState() -> Bool {
        let cfgPath = antigravityConfigPath()
        guard FileManager.default.fileExists(atPath: cfgPath),
              let raw = try? String(contentsOfFile: cfgPath, encoding: .utf8),
              let doc = try? MiniJson.parseObject(raw),
              let plugins = doc["plugins"]?.objectValue,
              let entry = plugins[pluginName] else {
            return false
        }
        if let b = entry.boolValue { return b }
        if let obj = entry.objectValue {
            if let enabled = obj["enabled"]?.boolValue { return enabled }
            return true
        }
        return false
    }

    static func writeTextAtomic(_ path: String, content: String) throws {
        let fm = FileManager.default
        let dir = (path as NSString).deletingLastPathComponent
        if !dir.isEmpty && !fm.fileExists(atPath: dir) {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)
        }
        let tmp = path + ".tmp.\(ProcessInfo.processInfo.processIdentifier).\(UUID().uuidString)"
        guard let data = content.data(using: .utf8) else {
            throw MiniJsonError(message: "UTF-8 encode failed")
        }
        try data.write(to: URL(fileURLWithPath: tmp), options: .atomic)
        if fm.fileExists(atPath: path) {
            _ = try fm.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))
        } else {
            try fm.moveItem(atPath: tmp, toPath: path)
        }
    }

    static func setPluginEnabledInConfigFile(_ enable: Bool) throws {
        let cfgPath = antigravityConfigPath()
        if !enable && !FileManager.default.fileExists(atPath: cfgPath) {
            return
        }
        var doc: [String: JsonValue] = [:]
        if FileManager.default.fileExists(atPath: cfgPath),
           let raw = try? String(contentsOfFile: cfgPath, encoding: .utf8),
           let parsed = try? MiniJson.parseObject(raw) {
            doc = parsed
        }
        var plugins = doc["plugins"]?.objectValue ?? [:]
        if enable {
            var entry = plugins[pluginName]?.objectValue ?? [:]
            entry["enabled"] = .bool(true)
            plugins[pluginName] = .object(entry)
        } else {
            plugins.removeValue(forKey: pluginName)
        }
        doc["plugins"] = .object(plugins)
        try writeTextAtomic(cfgPath, content: MiniJson.stringify(.object(doc), pretty: true) + "\n")
    }

    private static func tryStripDeprecatedFieldsAndWriteConfig(srcPath: String, destPath: String) -> Bool {
        guard let raw = try? String(contentsOfFile: srcPath, encoding: .utf8),
              var parsed = try? MiniJson.parseObject(raw) else {
            return false
        }
        parsed.removeValue(forKey: "exitOnHostClose")
        do {
            try writeTextAtomic(destPath, content: MiniJson.stringify(.object(parsed), pretty: true) + "\n")
            return true
        } catch {
            return false
        }
    }

    private static func stopLegacyLaunchAgentAndWatchers() {
        if isTestSandbox() { return }
        let plistPath = legacyLaunchAgentPlistPath()
        if FileManager.default.fileExists(atPath: plistPath) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            p.arguments = ["unload", "-w", plistPath]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
        }
        let killProc = Process()
        killProc.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        killProc.arguments = ["-f", "agy-claude-style-watcher"]
        killProc.standardOutput = FileHandle.nullDevice
        killProc.standardError = FileHandle.nullDevice
        try? killProc.run()
        killProc.waitUntilExit()
    }

    @discardableResult
    static func cleanupLegacyExternalArtifacts(installDir: String) -> Bool {
        let fm = FileManager.default
        var cleaned = false
        stopLegacyLaunchAgentAndWatchers()

        let plistPath = legacyLaunchAgentPlistPath()
        if fm.fileExists(atPath: plistPath) {
            if (try? fm.removeItem(atPath: plistPath)) != nil { cleaned = true }
        }

        let launcherApp = legacyLauncherAppPath()
        if fm.fileExists(atPath: launcherApp) {
            if (try? fm.removeItem(atPath: launcherApp)) != nil { cleaned = true }
        }

        let legacyDir = legacyInstallDir()
        if fm.fileExists(atPath: legacyDir) &&
            URL(fileURLWithPath: legacyDir).standardizedFileURL.path != URL(fileURLWithPath: installDir).standardizedFileURL.path {
            if (try? fm.removeItem(atPath: legacyDir)) != nil { cleaned = true }
        }

        let legacyInsidePlugin = [
            "agy-claude-style-watcher",
            "agy-claude-style-installer",
            "launch-antigravity.command",
            "Antigravity (AGY Claude Style).app",
            "manifest.json",
            ".install-mode",
            ".watch.pid",
        ]
        if fm.fileExists(atPath: installDir) {
            for rel in legacyInsidePlugin {
                let p = (installDir as NSString).appendingPathComponent(rel)
                if fm.fileExists(atPath: p) {
                    if (try? fm.removeItem(atPath: p)) != nil { cleaned = true }
                }
            }
        }
        return cleaned
    }

    private static func copyPayloadDirectory(from srcRoot: String, to destRoot: String) throws -> Int {
        let fm = FileManager.default
        if !fm.fileExists(atPath: srcRoot) {
            throw MiniJsonError(message: "安装包内部缺少原生插件资源目录 Resources/payload")
        }
        if !fm.fileExists(atPath: destRoot) {
            try fm.createDirectory(atPath: destRoot, withIntermediateDirectories: true, attributes: nil)
        }
        var count = 0
        guard let enumerator = fm.enumerator(atPath: srcRoot) else {
            throw MiniJsonError(message: "无法读取安装包插件资源目录")
        }
        while let rel = enumerator.nextObject() as? String {
            let srcPath = (srcRoot as NSString).appendingPathComponent(rel)
            let destPath = (destRoot as NSString).appendingPathComponent(rel)
            var isDir: ObjCBool = false
            fm.fileExists(atPath: srcPath, isDirectory: &isDir)
            if isDir.boolValue {
                if !fm.fileExists(atPath: destPath) {
                    try fm.createDirectory(atPath: destPath, withIntermediateDirectories: true, attributes: nil)
                }
            } else {
                let parent = (destPath as NSString).deletingLastPathComponent
                if !fm.fileExists(atPath: parent) {
                    try fm.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: nil)
                }
                if fm.fileExists(atPath: destPath) {
                    try fm.removeItem(atPath: destPath)
                }
                try fm.copyItem(atPath: srcPath, toPath: destPath)
                count += 1
            }
        }
        return count
    }

    static func readInstalledPluginVersion(installDir: String) -> String? {
        let pluginJson = (installDir as NSString).appendingPathComponent("plugin.json")
        guard FileManager.default.fileExists(atPath: pluginJson),
              let raw = try? String(contentsOfFile: pluginJson, encoding: .utf8),
              let parsed = try? MiniJson.parseObject(raw) else {
            return nil
        }
        return parsed["version"]?.stringValue
    }

    static func runInstall(_ opts: InstallerOptions, progress: ((Int, String) -> Void)? = nil) throws -> OperationResult {
        let fm = FileManager.default
        let installDir = opts.installDir.map { URL(fileURLWithPath: $0).standardizedFileURL.path } ?? defaultInstallDir()
        let dataDir = pluginDataDir()
        let legacyDir = legacyInstallDir()

        progress?(10, "正在准备插件配置目录...")
        if !fm.fileExists(atPath: dataDir) {
            try fm.createDirectory(atPath: dataDir, withIntermediateDirectories: true, attributes: nil)
        }

        var preservedExisting = false
        var migratedLegacy = false
        let activeCfgPath = (dataDir as NSString).appendingPathComponent("config.json")
        let legacyCfgPath = (legacyDir as NSString).appendingPathComponent("config.json")

        if fm.fileExists(atPath: activeCfgPath) {
            preservedExisting = tryStripDeprecatedFieldsAndWriteConfig(srcPath: activeCfgPath, destPath: activeCfgPath)
            if !preservedExisting { preservedExisting = true }
        } else if fm.fileExists(atPath: legacyCfgPath) {
            migratedLegacy = tryStripDeprecatedFieldsAndWriteConfig(srcPath: legacyCfgPath, destPath: activeCfgPath)
            if migratedLegacy { preservedExisting = true }
        }

        progress?(25, "正在通知运行中的 Antigravity 并清理旧版残留...")
        let daemons = discoverRunningLanguageServers()
        let lsPaused = trySetLsPluginState(daemons, enabled: false)
        if lsPaused {
            Thread.sleep(forTimeInterval: 0.45)
        }

        let legacyCleaned = cleanupLegacyExternalArtifacts(installDir: installDir)

        progress?(55, "正在部署原生插件包到 ~/.gemini/config/plugins/agy-claude-style...")
        guard let payloadRoot = Bundle.main.resourceURL?.appendingPathComponent("payload").path else {
            throw MiniJsonError(message: "无法定位 Bundle Resources/payload")
        }
        let fileCount = try copyPayloadDirectory(from: payloadRoot, to: installDir)

        if !fm.fileExists(atPath: activeCfgPath) {
            let exampleCfg = (installDir as NSString).appendingPathComponent("config.example.json")
            if fm.fileExists(atPath: exampleCfg) {
                try? fm.copyItem(atPath: exampleCfg, toPath: activeCfgPath)
            }
        }

        progress?(85, "正在启用 Antigravity Desktop 原生插件...")
        try setPluginEnabledInConfigFile(true)
        let lsEnabled = trySetLsPluginState(daemons, enabled: true)

        progress?(100, "原生插件部署完成。")
        let ag = detectAntigravity()
        var detail = "已以零后台进程模式部署 Antigravity Desktop 原生插件，共写入 \(fileCount) 个文件。\n"
        detail += "插件目录：\(installDir)\n"
        let cfgNote = migratedLegacy ? "（已从旧版目录迁移）" : (preservedExisting ? "（已保留现有配置）" : "（已生成默认配置）")
        detail += "用户配置：\(activeCfgPath)\(cfgNote)\n"
        if legacyCleaned {
            detail += "旧版清理：已自动清理旧版外部 Watcher / LaunchAgent / 启动器残留。\n"
        }
        detail += lsEnabled
            ? "生效方式：已通过 Antigravity Language Server 热启用，插件宿主正在自动注入样式与右侧 Claude Style 控制室。"
            : "生效方式：已写入插件启用配置；打开 Antigravity Desktop 后将由原生插件自动完成注入（无需外部常驻程序）。"

        return OperationResult(
            ok: true,
            mode: "install",
            headline: "AGY Claude Style 原生插件已安装！",
            detail: detail,
            installDir: installDir,
            pluginDataDir: dataDir,
            antigravityApp: ag.appPath,
            antigravityVersion: ag.version,
            preservedExistingConfig: preservedExisting,
            migratedLegacyConfig: migratedLegacy,
            legacyCleaned: legacyCleaned,
            pluginEnabled: readPluginEnabledState(),
            lsHotReloaded: lsEnabled,
            fileCount: fileCount,
            selfDeleteScheduled: false
        )
    }

    static func runUninstall(_ opts: InstallerOptions, progress: ((Int, String) -> Void)? = nil) throws -> OperationResult {
        let fm = FileManager.default
        let installDir = opts.installDir.map { URL(fileURLWithPath: $0).standardizedFileURL.path } ?? defaultInstallDir()
        let dataDir = pluginDataDir()

        progress?(25, "正在通知 Antigravity 停用并还原界面...")
        let daemons = discoverRunningLanguageServers()
        var lsStopped = tryDeleteLsPlugin(daemons)
        if !lsStopped {
            lsStopped = trySetLsPluginState(daemons, enabled: false)
        }
        if lsStopped {
            Thread.sleep(forTimeInterval: 0.45)
        }

        try? setPluginEnabledInConfigFile(false)

        progress?(60, "正在移除原生插件目录与旧版残留...")
        let legacyCleaned = cleanupLegacyExternalArtifacts(installDir: installDir)

        let bundlePath = URL(fileURLWithPath: Bundle.main.bundlePath).standardizedFileURL.path
        let runningInsideInstall = bundlePath.hasPrefix(installDir.hasSuffix("/") ? installDir : installDir + "/")
        if !runningInsideInstall && fm.fileExists(atPath: installDir) {
            try? fm.removeItem(atPath: installDir)
        }

        progress?(100, "卸载完成。")
        let ag = detectAntigravity()
        let activeCfgPath = (dataDir as NSString).appendingPathComponent("config.json")
        return OperationResult(
            ok: true,
            mode: "uninstall",
            headline: "已卸载 AGY Claude Style 原生插件",
            detail: "已移除原生插件目录：\(installDir)\n用户偏好配置保留在：\(activeCfgPath)",
            installDir: installDir,
            pluginDataDir: dataDir,
            antigravityApp: ag.appPath,
            antigravityVersion: ag.version,
            preservedExistingConfig: false,
            migratedLegacyConfig: false,
            legacyCleaned: legacyCleaned,
            pluginEnabled: readPluginEnabledState(),
            lsHotReloaded: lsStopped,
            fileCount: 0,
            selfDeleteScheduled: runningInsideInstall
        )
    }

    static func buildStatusDict(_ opts: InstallerOptions) -> [String: JsonValue] {
        let fm = FileManager.default
        let installDir = opts.installDir.map { URL(fileURLWithPath: $0).standardizedFileURL.path } ?? defaultInstallDir()
        let dataDir = pluginDataDir()
        let ag = detectAntigravity()
        let version = readInstalledPluginVersion(installDir: installDir)
        let pluginJson = (installDir as NSString).appendingPathComponent("plugin.json")
        let activeCfg = (dataDir as NSString).appendingPathComponent("config.json")
        let hasLegacy = fm.fileExists(atPath: legacyInstallDir())
            || fm.fileExists(atPath: legacyLaunchAgentPlistPath())
            || fm.fileExists(atPath: legacyLauncherAppPath())

        return [
            "installed": .bool(fm.fileExists(atPath: pluginJson)),
            "installedVersion": version.map { .string($0) } ?? .null,
            "pluginEnabled": .bool(readPluginEnabledState()),
            "installDir": .string(installDir),
            "pluginDataDir": .string(dataDir),
            "antigravityApp": ag.appPath.map { .string($0) } ?? .null,
            "antigravityVersion": ag.version.map { .string($0) } ?? .null,
            "hasConfig": .bool(fm.fileExists(atPath: activeCfg)),
            "hasLegacyInstall": .bool(hasLegacy),
        ]
    }
}

final class InstallerAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let opts: InstallerOptions
    private var window: NSWindow!
    private var statusTitle: NSTextField!
    private var statusBody: NSTextField!
    private var progressBar: NSProgressIndicator!
    private var logView: NSTextView!
    private var btnInstall: NSButton!
    private var btnUninstall: NSButton!
    private var btnOpenDir: NSButton!
    private var btnLaunchAg: NSButton!
    private var btnClose: NSButton!
    private var isBusy = false

    init(opts: InstallerOptions) {
        self.opts = opts
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupWindow()
        refreshStatus()
        if opts.uninstall {
            DispatchQueue.main.async { self.runAction(uninstall: true) }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        return !isBusy
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func setupWindow() {
        let frame = NSRect(x: 0, y: 0, width: 580, height: 470)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AGY Claude Style — 原生插件安装器"
        window.backgroundColor = NSColor(calibratedRed: 0.095, green: 0.088, blue: 0.084, alpha: 1.0)
        window.delegate = self
        window.center()

        guard let content = window.contentView else { return }

        let titleLbl = NSTextField(labelWithString: "AGY Claude Style 原生插件安装器")
        titleLbl.font = NSFont.boldSystemFont(ofSize: 17)
        titleLbl.textColor = NSColor(calibratedRed: 0.88, green: 0.48, blue: 0.35, alpha: 1.0)
        titleLbl.frame = NSRect(x: 24, y: 424, width: 532, height: 26)
        content.addSubview(titleLbl)

        let subLbl = NSTextField(labelWithString: "零后台守护进程 · 仅由 Antigravity Desktop 原生插件自动注入与控制")
        subLbl.font = NSFont.systemFont(ofSize: 12)
        subLbl.textColor = NSColor(calibratedWhite: 0.72, alpha: 1.0)
        subLbl.frame = NSRect(x: 24, y: 400, width: 532, height: 18)
        content.addSubview(subLbl)

        let card = NSView(frame: NSRect(x: 24, y: 264, width: 532, height: 124))
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor(calibratedRed: 0.13, green: 0.12, blue: 0.115, alpha: 1.0).cgColor
        card.layer?.cornerRadius = 8
        content.addSubview(card)

        statusTitle = NSTextField(labelWithString: "")
        statusTitle.font = NSFont.boldSystemFont(ofSize: 13)
        statusTitle.textColor = NSColor(calibratedWhite: 0.96, alpha: 1.0)
        statusTitle.frame = NSRect(x: 14, y: 92, width: 504, height: 22)
        card.addSubview(statusTitle)

        statusBody = NSTextField(wrappingLabelWithString: "")
        statusBody.font = NSFont.systemFont(ofSize: 12)
        statusBody.textColor = NSColor(calibratedWhite: 0.78, alpha: 1.0)
        statusBody.frame = NSRect(x: 14, y: 12, width: 504, height: 74)
        card.addSubview(statusBody)

        progressBar = NSProgressIndicator(frame: NSRect(x: 24, y: 236, width: 532, height: 16))
        progressBar.isIndeterminate = false
        progressBar.minValue = 0
        progressBar.maxValue = 100
        progressBar.doubleValue = 0
        content.addSubview(progressBar)

        let scroll = NSScrollView(frame: NSRect(x: 24, y: 72, width: 532, height: 150))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        logView = NSTextView(frame: NSRect(x: 0, y: 0, width: 530, height: 148))
        logView.isEditable = false
        logView.backgroundColor = NSColor(calibratedRed: 0.075, green: 0.07, blue: 0.068, alpha: 1.0)
        logView.textColor = NSColor(calibratedWhite: 0.85, alpha: 1.0)
        logView.font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
        scroll.documentView = logView
        content.addSubview(scroll)

        btnInstall = NSButton(title: "安装 / 更新插件", target: self, action: #selector(onInstall))
        btnInstall.frame = NSRect(x: 24, y: 20, width: 132, height: 34)
        content.addSubview(btnInstall)

        btnUninstall = NSButton(title: "卸载插件", target: self, action: #selector(onUninstall))
        btnUninstall.frame = NSRect(x: 166, y: 20, width: 92, height: 34)
        content.addSubview(btnUninstall)

        btnOpenDir = NSButton(title: "打开插件目录", target: self, action: #selector(onOpenDir))
        btnOpenDir.frame = NSRect(x: 268, y: 20, width: 112, height: 34)
        content.addSubview(btnOpenDir)

        btnLaunchAg = NSButton(title: "打开 Antigravity", target: self, action: #selector(onLaunchAg))
        btnLaunchAg.frame = NSRect(x: 388, y: 20, width: 112, height: 34)
        content.addSubview(btnLaunchAg)

        btnClose = NSButton(title: "关闭", target: self, action: #selector(onClose))
        btnClose.frame = NSRect(x: 506, y: 20, width: 50, height: 34)
        content.addSubview(btnClose)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func appendLog(_ text: String) {
        let line = logView.string.isEmpty ? text : "\n" + text
        logView.textStorage?.append(NSAttributedString(string: line, attributes: [
            .foregroundColor: NSColor(calibratedWhite: 0.85, alpha: 1.0),
            .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
        ]))
        logView.scrollToEndOfDocument(nil)
    }

    private func refreshStatus() {
        let st = InstallerCore.buildStatusDict(opts)
        let installed = st["installed"]?.boolValue ?? false
        let enabled = st["pluginEnabled"]?.boolValue ?? false
        let ver = st["installedVersion"]?.stringValue ?? "?"
        let agVer = st["antigravityVersion"]?.stringValue
        let installDir = st["installDir"]?.stringValue ?? ""
        let dataDir = st["pluginDataDir"]?.stringValue ?? ""
        let hasLegacy = st["hasLegacyInstall"]?.boolValue ?? false

        statusTitle.stringValue = installed
            ? "当前状态：已安装原生插件 v\(ver)" + (enabled ? "（已启用）" : "（未启用）")
            : "当前状态：尚未安装原生插件"

        var body = "Antigravity：" + (agVer.map { "已检测到 \($0)" } ?? "未在默认路径检测到（仍可离线部署插件）") + "\n"
        body += "插件路径：\(installDir)\n"
        body += "配置目录：\(dataDir)"
        if hasLegacy {
            body += "\n迁移提示：检测到旧版外部安装/自启残留，安装时将自动迁移配置并清理。"
        }
        statusBody.stringValue = body
        btnInstall.title = installed ? "更新插件" : "安装插件"
        btnUninstall.isEnabled = installed
        btnLaunchAg.isEnabled = st["antigravityApp"]?.stringValue != nil
    }

    private func setBusy(_ busy: Bool) {
        isBusy = busy
        btnInstall.isEnabled = !busy
        btnUninstall.isEnabled = !busy
        btnOpenDir.isEnabled = !busy
        btnLaunchAg.isEnabled = !busy
    }

    @objc private func onInstall() { runAction(uninstall: false) }
    @objc private func onUninstall() { runAction(uninstall: true) }

    @objc private func onOpenDir() {
        let dir = opts.installDir ?? InstallerCore.defaultInstallDir()
        let target = FileManager.default.fileExists(atPath: dir) ? dir : (dir as NSString).deletingLastPathComponent
        NSWorkspace.shared.open(URL(fileURLWithPath: target))
    }

    @objc private func onLaunchAg() {
        let ag = InstallerCore.detectAntigravity()
        if let appPath = ag.appPath {
            NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
        }
    }

    @objc private func onClose() {
        if !isBusy { window.close() }
    }

    private func runAction(uninstall: Bool) {
        if isBusy { return }
        setBusy(true)
        progressBar.doubleValue = 0
        logView.string = ""
        appendLog(uninstall ? "[*] 开始卸载原生插件..." : "[*] 开始安装原生插件...")

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let onProgress: (Int, String) -> Void = { pct, msg in
                    DispatchQueue.main.async {
                        self.progressBar.doubleValue = Double(pct)
                        self.appendLog("[\(pct)%] \(msg)")
                    }
                }
                let res = uninstall
                    ? try InstallerCore.runUninstall(self.opts, progress: onProgress)
                    : try InstallerCore.runInstall(self.opts, progress: onProgress)
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.refreshStatus()
                    self.appendLog("[✓] \(res.headline)")
                    self.appendLog(res.detail)
                    let alert = NSAlert()
                    alert.messageText = res.headline
                    alert.informativeText = res.detail
                    alert.runModal()
                }
            } catch {
                DispatchQueue.main.async {
                    self.setBusy(false)
                    self.refreshStatus()
                    self.appendLog("[✗] 操作失败: \(error.localizedDescription)")
                    let alert = NSAlert()
                    alert.alertStyle = .critical
                    alert.messageText = "AGY Claude Style 操作失败"
                    alert.informativeText = error.localizedDescription
                    alert.runModal()
                }
            }
        }
    }
}

func parseArgs(_ args: [String]) -> InstallerOptions {
    var opts = InstallerOptions()
    var i = 1
    while i < args.count {
        let a = args[i]
        if a == "--uninstall" { opts.uninstall = true }
        else if a == "--silent" || a == "-s" { opts.silent = true }
        else if a == "--popup" { opts.popup = true }
        else if a == "--status" { opts.statusOnly = true }
        else if a == "--install-dir", i + 1 < args.count {
            i += 1
            opts.installDir = args[i]
        } else if a == "--out", i + 1 < args.count {
            i += 1
            opts.outFile = args[i]
        }
        i += 1
    }
    return opts
}

func writeOutFile(_ outFile: String?, res: OperationResult) {
    guard let outFile = outFile, !outFile.isEmpty else { return }
    let dict: [String: JsonValue] = [
        "ok": .bool(res.ok),
        "mode": .string(res.mode),
        "headline": .string(res.headline),
        "detail": .string(res.detail),
        "installDir": .string(res.installDir),
        "pluginDataDir": .string(res.pluginDataDir),
        "antigravityApp": res.antigravityApp.map { .string($0) } ?? .null,
        "antigravityVersion": res.antigravityVersion.map { .string($0) } ?? .null,
        "preservedExistingConfig": .bool(res.preservedExistingConfig),
        "migratedLegacyConfig": .bool(res.migratedLegacyConfig),
        "legacyCleaned": .bool(res.legacyCleaned),
        "pluginEnabled": .bool(res.pluginEnabled),
        "lsHotReloaded": .bool(res.lsHotReloaded),
        "fileCount": .int(Int64(res.fileCount)),
        "selfDeleteScheduled": .bool(res.selfDeleteScheduled),
    ]
    let json = MiniJson.stringify(.object(dict), pretty: true)
    try? json.data(using: .utf8)?.write(to: URL(fileURLWithPath: outFile))
}

let opts = parseArgs(CommandLine.arguments)

if opts.statusOnly {
    let st = InstallerCore.buildStatusDict(opts)
    let json = MiniJson.stringify(.object(st), pretty: true)
    if let outFile = opts.outFile, !outFile.isEmpty {
        try? json.data(using: .utf8)?.write(to: URL(fileURLWithPath: outFile))
    } else {
        print(json)
    }
    exit(0)
}

if opts.silent {
    do {
        let res = opts.uninstall
            ? try InstallerCore.runUninstall(opts)
            : try InstallerCore.runInstall(opts)
        writeOutFile(opts.outFile, res: res)
        exit(res.ok ? 0 : 1)
    } catch {
        if let outFile = opts.outFile, !outFile.isEmpty {
            let errJson = MiniJson.stringify(.object([
                "ok": .bool(false),
                "error": .string(error.localizedDescription),
            ]), pretty: true)
            try? errJson.data(using: .utf8)?.write(to: URL(fileURLWithPath: outFile))
        }
        exit(1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = InstallerAppDelegate(opts: opts)
app.delegate = delegate
app.run()
