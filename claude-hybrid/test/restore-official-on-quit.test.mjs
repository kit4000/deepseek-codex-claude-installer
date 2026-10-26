import assert from "node:assert/strict";
import test from "node:test";
import {
  renderRestoreOfficialPlist,
  renderRestoreOfficialScript,
} from "../scripts/setup-restore-official-on-quit.mjs";

test("restore-on-quit script waits for Claude and never kills it", () => {
  const script = renderRestoreOfficialScript({
    officialApp: "/Users/test/Applications/Claude Official.app",
    dailyApp: "/Applications/Claude.app",
    logPath: "/Users/test/Library/Logs/Claude Hybrid/restore-official.log",
    okPath: "/Users/test/Library/Logs/Claude Hybrid/restore-official.ok",
  });
  assert.match(script, /Managed by deepseek-codex-claude-installer\. restore-official-on-quit/);
  assert.match(script, /pgrep -x Claude/);
  assert.doesNotMatch(script, /\bkill\b|\bkillall\b/);
  assert.match(script, /Claude\.app\.before-deepseek-restore-/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /com\.local\.claude-hybrid-router/);
  assert.match(script, /bootout/);
  assert.match(script, /cp -cR|ditto/);
});

test("restore-on-quit LaunchAgent is RunAtLoad one-shot", () => {
  const plist = renderRestoreOfficialPlist({
    scriptPath: "/Users/test/Library/Application Support/Claude Hybrid/restore-official-claude.sh",
    logPath: "/Users/test/Library/Logs/Claude Hybrid/restore-official.log",
  });
  assert.match(plist, /com\.local\.restore-official-claude/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/s);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/s);
  assert.match(plist, /restore-official-claude\.sh/);
});
