#!/usr/bin/env bash
# AGY Claude Style - macOS & Linux One-Liner Installer / Updater / Uninstaller
# Zero external Node.js or Git required on target machine.
# Install / Update:
#   curl -fsSL https://raw.githubusercontent.com/0DNANCY/agy-claude-style/main/install.sh | bash
# Uninstall:
#   curl -fsSL https://raw.githubusercontent.com/0DNANCY/agy-claude-style/main/install.sh | bash -s -- --uninstall
set -euo pipefail

PLUGIN_NAME="agy-claude-style"
SIDECAR_NAME="agy-claude-style/panel"
REPO_OWNER="0DNANCY"
REPO_NAME="agy-claude-style"
LEGACY_LAUNCH_AGENT="io.github.0dnancy.agy-claude-style"

MODE="install"
REQ_VERSION=""
INSTALL_DIR=""
ARCHIVE_PATH=""
SOURCE_DIR=""
OUT_FILE=""
JSON_OUT=0
SILENT=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall) MODE="uninstall"; shift ;;
    --status|status) MODE="status"; shift ;;
    --version) REQ_VERSION="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --archive) ARCHIVE_PATH="${2:-}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
    --out) OUT_FILE="${2:-}"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    --silent|-s) SILENT=1; shift ;;
    *) shift ;;
  esac
done

is_sandbox() {
  [ -n "${AGY_CS_TEST_SYSTEM_ROOT:-}" ]
}

resolve_gemini_dir() {
  if [ -n "${AGY_CS_TEST_SYSTEM_ROOT:-}" ]; then
    printf '%s/.gemini' "${AGY_CS_TEST_SYSTEM_ROOT%/}"
    return
  fi
  if [ -n "${ANTIGRAVITY_GEMINI_DIR:-}" ]; then
    printf '%s' "${ANTIGRAVITY_GEMINI_DIR%/}"
    return
  fi
  printf '%s/.gemini' "$HOME"
}

GEMINI_DIR="$(resolve_gemini_dir)"
[ -n "$INSTALL_DIR" ] || INSTALL_DIR="${GEMINI_DIR}/config/plugins/${PLUGIN_NAME}"
PLUGIN_DATA_DIR="${GEMINI_DIR}/antigravity/plugin_data/${PLUGIN_NAME}"
AG_CONFIG_PATH="${GEMINI_DIR}/config/config.json"

resolve_legacy_dir() {
  if [ -n "${AGY_CS_TEST_SYSTEM_ROOT:-}" ]; then
    printf '%s/LegacyAppSupport/%s' "${AGY_CS_TEST_SYSTEM_ROOT%/}" "$PLUGIN_NAME"
  elif [ "$(uname -s)" = "Darwin" ]; then
    printf '%s/Library/Application Support/%s' "$HOME" "$PLUGIN_NAME"
  else
    printf '%s/%s' "${XDG_CONFIG_HOME:-$HOME/.config}" "$PLUGIN_NAME"
  fi
}

json_tool() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
  elif command -v node >/dev/null 2>&1; then
    echo "node"
  else
    echo "none"
  fi
}

JSON_BIN="$(json_tool)"

strip_deprecated_copy_config() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ "$JSON_BIN" = "python3" ]; then
    python3 - "$src" "$dst" <<'PY' 2>/dev/null || return 1
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, 'r', encoding='utf-8') as f:
    data = json.load(f)
if not isinstance(data, dict):
    sys.exit(1)
data.pop('exitOnHostClose', None)
tmp = f"{dst}.tmp.{os.getpid()}"
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')
os.replace(tmp, dst)
PY
    return $?
  elif [ "$JSON_BIN" = "node" ]; then
    node - "$src" "$dst" <<'JS' 2>/dev/null || return 1
const fs = require('fs');
const [src, dst] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!data || typeof data !== 'object' || Array.isArray(data)) process.exit(1);
delete data.exitOnHostClose;
const tmp = `${dst}.tmp.${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, dst);
JS
    return $?
  else
    cp "$src" "$dst"
    return 0
  fi
}

read_plugin_enabled() {
  [ -f "$AG_CONFIG_PATH" ] || { echo "false"; return; }
  if [ "$JSON_BIN" = "python3" ]; then
    python3 - "$AG_CONFIG_PATH" "$PLUGIN_NAME" <<'PY' 2>/dev/null || echo "false"
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        doc = json.load(f)
    entry = (doc.get('plugins') or {}).get(sys.argv[2])
    if isinstance(entry, bool):
        print('true' if entry else 'false')
    elif isinstance(entry, dict):
        print('true' if entry.get('enabled', True) else 'false')
    else:
        print('false')
except Exception:
    print('false')
PY
  elif [ "$JSON_BIN" = "node" ]; then
    node - "$AG_CONFIG_PATH" "$PLUGIN_NAME" <<'JS' 2>/dev/null || echo "false"
const fs = require('fs');
try {
  const doc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const e = doc?.plugins?.[process.argv[3]];
  if (typeof e === 'boolean') console.log(e ? 'true' : 'false');
  else if (e && typeof e === 'object') console.log(e.enabled === false ? 'false' : 'true');
  else console.log('false');
} catch { console.log('false'); }
JS
  else
    grep -q "\"$PLUGIN_NAME\"" "$AG_CONFIG_PATH" && echo "true" || echo "false"
  fi
}

set_plugin_enabled_in_config() {
  local enable="$1"
  if [ "$enable" != "true" ] && [ ! -f "$AG_CONFIG_PATH" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$AG_CONFIG_PATH")"
  if [ "$JSON_BIN" = "python3" ]; then
    python3 - "$AG_CONFIG_PATH" "$PLUGIN_NAME" "$enable" <<'PY'
import json, os, sys
cfg_path, plugin_name, enable_str = sys.argv[1], sys.argv[2], sys.argv[3]
enable = enable_str == 'true'
doc = {}
if os.path.exists(cfg_path):
    try:
        with open(cfg_path, 'r', encoding='utf-8') as f:
            parsed = json.load(f)
        if isinstance(parsed, dict):
            doc = parsed
    except Exception:
        doc = {}
if not isinstance(doc.get('plugins'), dict):
    doc['plugins'] = {}
if enable:
    entry = doc['plugins'].get(plugin_name)
    if not isinstance(entry, dict):
        entry = {}
    entry['enabled'] = True
    doc['plugins'][plugin_name] = entry
else:
    doc['plugins'].pop(plugin_name, None)
tmp = f"{cfg_path}.tmp.{os.getpid()}"
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')
os.replace(tmp, cfg_path)
PY
  elif [ "$JSON_BIN" = "node" ]; then
    node - "$AG_CONFIG_PATH" "$PLUGIN_NAME" "$enable" <<'JS'
const fs = require('fs');
const [cfgPath, pluginName, enableStr] = process.argv.slice(2);
const enable = enableStr === 'true';
let doc = {};
if (fs.existsSync(cfgPath)) {
  try {
    const p = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (p && typeof p === 'object' && !Array.isArray(p)) doc = p;
  } catch {}
}
if (!doc.plugins || typeof doc.plugins !== 'object' || Array.isArray(doc.plugins)) doc.plugins = {};
if (enable) {
  const prev = doc.plugins[pluginName];
  const entry = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};
  entry.enabled = true;
  doc.plugins[pluginName] = entry;
} else {
  delete doc.plugins[pluginName];
}
const tmp = `${cfgPath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, cfgPath);
JS
  else
    if [ "$enable" = "true" ] && [ ! -f "$AG_CONFIG_PATH" ]; then
      printf '{\n  "plugins": {\n    "%s": {\n      "enabled": true\n    }\n  }\n}\n' "$PLUGIN_NAME" > "$AG_CONFIG_PATH"
    fi
  fi
}

call_running_ls() {
  local method="$1" body="$2"
  is_sandbox && return 1
  local daemon_dir="${GEMINI_DIR}/antigravity/daemon"
  [ -d "$daemon_dir" ] || return 1
  local any_ok=1
  for f in "$daemon_dir"/*.json; do
    [ -f "$f" ] || continue
    local info=""
    if [ "$JSON_BIN" = "python3" ]; then
      info="$(python3 - "$f" <<'PY' 2>/dev/null || true
import json, os, sys
try:
    d = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
    pid, port, csrf = int(d['pid']), int(d['httpPort']), str(d['csrfToken'])
    os.kill(pid, 0)
    print(f"{port} {csrf}")
except Exception:
    pass
PY
)"
    fi
    [ -n "$info" ] || continue
    local port="${info%% *}" csrf="${info#* }"
    if curl -fsS --max-time 3 -X POST \
      "http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}" \
      -H "Content-Type: application/json" \
      -H "Connect-Protocol-Version: 1" \
      -H "x-codeium-csrf-token: ${csrf}" \
      -H "x-antigravity-csrf-token: ${csrf}" \
      -d "$body" >/dev/null 2>&1; then
      any_ok=0
    fi
  done
  return "$any_ok"
}

cleanup_legacy_artifacts() {
  local cleaned="false"
  local plist app_path legacy_dir
  if [ -n "${AGY_CS_TEST_SYSTEM_ROOT:-}" ]; then
    plist="${AGY_CS_TEST_SYSTEM_ROOT%/}/LaunchAgents/${LEGACY_LAUNCH_AGENT}.plist"
    app_path="${AGY_CS_TEST_SYSTEM_ROOT%/}/Applications/Antigravity (AGY Claude Style).app"
  else
    plist="${HOME}/Library/LaunchAgents/${LEGACY_LAUNCH_AGENT}.plist"
    app_path="${HOME}/Applications/Antigravity (AGY Claude Style).app"
  fi
  if [ -f "$plist" ]; then
    if ! is_sandbox && command -v launchctl >/dev/null 2>&1; then
      launchctl unload -w "$plist" >/dev/null 2>&1 || true
    fi
    rm -f "$plist" && cleaned="true"
  fi
  if [ -d "$app_path" ]; then
    rm -rf "$app_path" && cleaned="true"
  fi
  legacy_dir="$(resolve_legacy_dir)"
  if [ -d "$legacy_dir" ] && [ "$legacy_dir" != "$INSTALL_DIR" ]; then
    rm -rf "$legacy_dir" && cleaned="true"
  fi
  for f in agy-claude-style-watcher manifest.json .install-mode .watch.pid; do
    if [ -e "${INSTALL_DIR}/${f}" ]; then
      rm -f "${INSTALL_DIR}/${f}" && cleaned="true"
    fi
  done
  echo "$cleaned"
}

read_installed_version() {
  local pj="${INSTALL_DIR}/plugin.json"
  [ -f "$pj" ] || { echo ""; return; }
  if [ "$JSON_BIN" = "python3" ]; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1],encoding='utf-8')).get('version',''))" "$pj" 2>/dev/null || true
  elif [ "$JSON_BIN" = "node" ]; then
    node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version||'')" "$pj" 2>/dev/null || true
  fi
}

extract_zip_safe() {
  local zip_path="$1" dest_dir="$2"
  mkdir -p "$dest_dir"
  local tmp_extract
  tmp_extract="$(mktemp -d)"
  trap 'rm -rf "$tmp_extract"' RETURN
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$zip_path" -d "$tmp_extract"
  elif [ "$JSON_BIN" = "python3" ]; then
    python3 -m zipfile -e "$zip_path" "$tmp_extract"
  else
    echo "[!] Neither unzip nor python3 is available to extract $zip_path" >&2
    exit 1
  fi
  local src_root="$tmp_extract"
  if [ ! -f "${src_root}/plugin.json" ]; then
    local sub_count
    sub_count="$(find "$tmp_extract" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
    if [ "$sub_count" = "1" ]; then
      local only_dir
      only_dir="$(find "$tmp_extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
      if [ -f "${only_dir}/plugin.json" ]; then
        src_root="$only_dir"
      fi
    fi
  fi
  copy_source_dir "$src_root" "$dest_dir"
}

copy_source_dir() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  local count=0
  while IFS= read -r -d '' file; do
    local rel="${file#${src%/}/}"
    case "$rel" in
      .git/*|dist/*|node_modules/*|installer/*|test/*|*/.DS_Store|.DS_Store|Thumbs.db|.watch.pid|watch.log|config.json)
        continue
        ;;
    esac
    local target="${dst%/}/${rel}"
    mkdir -p "$(dirname "$target")"
    cp -f "$file" "$target"
    count=$((count + 1))
  done < <(find "${src%/}" -type f -print0)
  echo "$count"
}

resolve_download_url() {
  if [ -n "$REQ_VERSION" ]; then
    local tag="${REQ_VERSION#v}"
    echo "https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${tag}/agy-claude-style-v${tag}.zip"
    return
  fi
  local latest_url=""
  if command -v curl >/dev/null 2>&1; then
    local json
    json="$(curl -fsSL --max-time 10 -H "User-Agent: agy-claude-style-installer/4.0.0" \
      "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" 2>/dev/null || true)"
    if [ -n "$json" ] && [ "$JSON_BIN" = "python3" ]; then
      latest_url="$(python3 - "$json" <<'PY' 2>/dev/null || true
import json, re, sys
try:
    rel = json.loads(sys.argv[1])
    for a in rel.get('assets') or []:
        if re.match(r'^agy-claude-style-v.*\.zip$', str(a.get('name', ''))):
            print(a.get('browser_download_url', ''))
            break
except Exception:
    pass
PY
)"
    fi
  fi
  if [ -n "$latest_url" ]; then
    echo "$latest_url"
  else
    echo "https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/main.zip"
  fi
}

emit_json_out() {
  local json_text="$1"
  if [ -n "$OUT_FILE" ]; then
    mkdir -p "$(dirname "$OUT_FILE")"
    printf '%s\n' "$json_text" > "$OUT_FILE"
  fi
}

if [ "$MODE" = "status" ]; then
  INSTALLED="false"
  [ -f "${INSTALL_DIR}/plugin.json" ] && INSTALLED="true"
  VER="$(read_installed_version)"
  ENABLED="$(read_plugin_enabled)"
  HAS_CFG="false"; [ -f "${PLUGIN_DATA_DIR}/config.json" ] && HAS_CFG="true"
  HAS_WP="false"; [ -d "${PLUGIN_DATA_DIR}/wallpapers" ] && HAS_WP="true"
  JSON_PAYLOAD="{\"ok\":true,\"mode\":\"status\",\"installed\":${INSTALLED},\"installedVersion\":\"${VER}\",\"pluginEnabled\":${ENABLED},\"installDir\":\"${INSTALL_DIR}\",\"pluginDataDir\":\"${PLUGIN_DATA_DIR}\",\"hasConfig\":${HAS_CFG},\"hasWallpapersDir\":${HAS_WP}}"
  emit_json_out "$JSON_PAYLOAD"
  if [ "$SILENT" -eq 0 ]; then
    if [ "$JSON_OUT" -eq 1 ]; then
      printf '%s\n' "$JSON_PAYLOAD"
    else
      echo "AGY Claude Style: ${INSTALLED} (version=${VER:-none}, enabled=${ENABLED})"
      echo "  Plugin Dir: ${INSTALL_DIR}"
      echo "  Data Dir:   ${PLUGIN_DATA_DIR}"
    fi
  fi
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  LS_RELOADED="false"
  if call_running_ls "DeletePlugin" "{\"pluginName\":\"${PLUGIN_NAME}\"}" || \
     call_running_ls "JetboxWriteState" "{\"plugins\":{\"${PLUGIN_NAME}\":{\"enabled\":false}},\"sidecars\":{\"${SIDECAR_NAME}\":{\"enabled\":false}}}"; then
    LS_RELOADED="true"
    sleep 0.35
  fi
  set_plugin_enabled_in_config "false"
  LEGACY_CLEANED="$(cleanup_legacy_artifacts)"
  rm -rf "$INSTALL_DIR"
  ENABLED="$(read_plugin_enabled)"
  JSON_PAYLOAD="{\"ok\":true,\"mode\":\"uninstall\",\"installDir\":\"${INSTALL_DIR}\",\"pluginDataDir\":\"${PLUGIN_DATA_DIR}\",\"legacyCleaned\":${LEGACY_CLEANED},\"pluginEnabled\":${ENABLED},\"lsHotReloaded\":${LS_RELOADED}}"
  emit_json_out "$JSON_PAYLOAD"
  if [ "$SILENT" -eq 0 ]; then
    if [ "$JSON_OUT" -eq 1 ]; then
      printf '%s\n' "$JSON_PAYLOAD"
    else
      echo "[OK] Uninstalled AGY Claude Style from ${INSTALL_DIR}"
      echo "     User data preserved at ${PLUGIN_DATA_DIR}"
    fi
  fi
  exit 0
fi

mkdir -p "$PLUGIN_DATA_DIR"
ACTIVE_CFG="${PLUGIN_DATA_DIR}/config.json"
LEGACY_CFG="$(resolve_legacy_dir)/config.json"
PRESERVED="false"
MIGRATED="false"
if [ -f "$ACTIVE_CFG" ]; then
  strip_deprecated_copy_config "$ACTIVE_CFG" "$ACTIVE_CFG" || true
  PRESERVED="true"
elif [ -f "$LEGACY_CFG" ]; then
  if strip_deprecated_copy_config "$LEGACY_CFG" "$ACTIVE_CFG"; then
    MIGRATED="true"
    PRESERVED="true"
  fi
fi

if call_running_ls "JetboxWriteState" "{\"plugins\":{\"${PLUGIN_NAME}\":{\"enabled\":false}},\"sidecars\":{\"${SIDECAR_NAME}\":{\"enabled\":false}}}"; then
  sleep 0.35
fi
LEGACY_CLEANED="$(cleanup_legacy_artifacts)"

FILE_COUNT=0
if [ -n "$SOURCE_DIR" ]; then
  FILE_COUNT="$(copy_source_dir "$SOURCE_DIR" "$INSTALL_DIR")"
else
  TMP_ZIP=""
  if [ -n "$ARCHIVE_PATH" ]; then
    ZIP_USE="$ARCHIVE_PATH"
  else
    DL_URL="$(resolve_download_url)"
    TMP_ZIP="$(mktemp "${TMPDIR:-/tmp}/agy-cs-XXXXXX.zip")"
    [ "$SILENT" -eq 0 ] && echo "[*] Downloading AGY Claude Style from ${DL_URL} ..."
    curl -fsSL "$DL_URL" -o "$TMP_ZIP"
    ZIP_USE="$TMP_ZIP"
  fi
  FILE_COUNT="$(extract_zip_safe "$ZIP_USE" "$INSTALL_DIR")"
  [ -n "$TMP_ZIP" ] && rm -f "$TMP_ZIP"
fi

if [ ! -f "$ACTIVE_CFG" ] && [ -f "${INSTALL_DIR}/config.example.json" ]; then
  cp "${INSTALL_DIR}/config.example.json" "$ACTIVE_CFG"
fi

set_plugin_enabled_in_config "true"
LS_RELOADED="false"
if call_running_ls "JetboxWriteState" "{\"plugins\":{\"${PLUGIN_NAME}\":{\"enabled\":true}},\"sidecars\":{\"${SIDECAR_NAME}\":{\"enabled\":true}}}"; then
  LS_RELOADED="true"
fi
VER="$(read_installed_version)"
ENABLED="$(read_plugin_enabled)"

JSON_PAYLOAD="{\"ok\":true,\"mode\":\"install\",\"version\":\"${VER}\",\"installDir\":\"${INSTALL_DIR}\",\"pluginDataDir\":\"${PLUGIN_DATA_DIR}\",\"configPath\":\"${ACTIVE_CFG}\",\"preservedExistingConfig\":${PRESERVED},\"migratedLegacyConfig\":${MIGRATED},\"legacyCleaned\":${LEGACY_CLEANED},\"pluginEnabled\":${ENABLED},\"lsHotReloaded\":${LS_RELOADED},\"fileCount\":${FILE_COUNT}}"
emit_json_out "$JSON_PAYLOAD"
if [ "$SILENT" -eq 0 ]; then
  if [ "$JSON_OUT" -eq 1 ]; then
    printf '%s\n' "$JSON_PAYLOAD"
  else
    echo "[OK] Installed AGY Claude Style v${VER:-?} (${FILE_COUNT} files) -> ${INSTALL_DIR}"
    if [ "$LS_RELOADED" = "true" ]; then
      echo "     Hot-enabled via running Antigravity Language Server."
    else
      echo "     Enabled in Antigravity config.json (takes effect on Antigravity launch)."
    fi
  fi
fi
