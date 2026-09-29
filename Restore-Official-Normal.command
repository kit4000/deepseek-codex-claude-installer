#!/bin/bash
# Double-click in Finder (or run in Terminal) to force Official Claude out of
# DeepSeek-only Claude-3p mode. Does not kill Claude. Does not delete sessions.
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"

echo "=== Restore Official Claude (remove DeepSeek-only 3p) ==="
uname -s | grep -qx Darwin || { echo "This must run on macOS."; exit 1; }

SUPPORT="$HOME/Library/Application Support/Claude-3p"
STAMP="$(date +%Y%m%d%H%M%S)"

# 1) Always quarantine Claude-3p first (this alone fixes DeepSeek-only Official).
if [ -d "$SUPPORT" ]; then
  DEST="${SUPPORT}.before-official-normal-${STAMP}"
  echo "Quarantining:"
  echo "  $SUPPORT"
  echo "-> $DEST"
  mv "$SUPPORT" "$DEST"
  echo "CLAUDE_3P_QUARANTINED_OK"
else
  echo "Claude-3p already absent (OK)"
fi

# 2) Best-effort: pull installer + refresh Cloud.app from Official zip.
INSTALLER=""
for candidate in \
  "$HOME/Applications/deepseek-codex-claude-installer" \
  "$HOME/Projects/deepseek/deepseek-codex-claude-installer-repo"
do
  if [ -d "$candidate/.git" ]; then INSTALLER="$candidate"; break; fi
done

if [ -n "$INSTALLER" ]; then
  echo "Installer: $INSTALLER"
  cd "$INSTALLER"
  git fetch origin cursor/cloud-app-latest-official-481a || true
  git checkout cursor/cloud-app-latest-official-481a || true
  git pull --ff-only origin cursor/cloud-app-latest-official-481a || true
  node scripts/install-extensions.mjs || true
  if command -v restore-official-normal >/dev/null 2>&1; then
    RESTORE_OFFICIAL_REFRESH_APP=1 restore-official-normal --refresh-app || true
  elif [ -f claude-hybrid/scripts/restore-official-normal.mjs ]; then
    RESTORE_OFFICIAL_REFRESH_APP=1 node claude-hybrid/scripts/restore-official-normal.mjs --refresh-app || true
  fi
else
  echo "Installer checkout not found; Claude-3p quarantine alone was applied."
fi

CLOUD="$HOME/Applications/Cloud.app"
echo
echo "=== VERIFY ==="
if [ -d "$SUPPORT" ]; then
  echo "CLAUDE_3P_STILL_PRESENT — restore failed"
  ls -ld "$SUPPORT"
  exit 3
fi
echo "CLAUDE_3P_GONE_OK"
ls -ld "$HOME/Library/Application Support"/Claude-3p.before-official-normal-* 2>/dev/null | tail -3 || true

if [ -d "$CLOUD" ]; then
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$CLOUD/Contents/Info.plist" 2>/dev/null || true
  if plutil -extract ClaudeHybridPatchVersion raw -o - "$CLOUD/Contents/Info.plist" >/dev/null 2>&1; then
    echo "WARNING: Cloud.app still has Hybrid marker — replace with Official zip"
  else
    echo "Cloud.app has no Hybrid marker (OK)"
  fi
else
  echo "Cloud.app missing at $CLOUD — install Official there after quitting Claude"
fi

echo
if pgrep -x Claude >/dev/null 2>&1; then
  echo "Claude is still running. Fully Quit Claude/Cloud.app from the menu, then run:"
  echo "  open -n \"$CLOUD\""
  pgrep -lx Claude || true
else
  if [ -d "$CLOUD" ]; then
    open -n "$CLOUD"
    echo "Opened: open -n $CLOUD"
  fi
fi

echo
echo "Done. You should now see the normal Anthropic account and native models,"
echo "not only DeepSeek V4 Pro / Flash."
echo
read -r -p "Press Return to close…" _
