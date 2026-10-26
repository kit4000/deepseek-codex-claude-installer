import assert from "node:assert/strict";
import test from "node:test";
import {
  installPinnedOfficialApp,
  officialBackupPath,
  pinnedOfficialRelease,
} from "../src/official-source.mjs";

const releaseInput = {
  officialVersion: "2.9939.2",
  officialZipUrl: "https://downloads.claude.ai/releases/darwin/universal/2.9939.2/Claude-d3e50475d5d6bb0c317560310200249dd61b87d8.zip",
  officialZipSha256: "6acf8c42a60eda212841ba66a6439c7140c59c4022220a177d9cd44b5a94913c",
};

test("pins only the verified Claude desktop zip", () => {
  const release = pinnedOfficialRelease(releaseInput);
  assert.equal(release.version, "2.9939.2");
  assert.throws(() => pinnedOfficialRelease({ ...releaseInput, officialVersion: "2.7032.0" }), /does not match/);
  assert.throws(() => pinnedOfficialRelease({ ...releaseInput, officialZipUrl: "http://downloads.claude.ai/Claude.zip" }), /does not match/);
  assert.throws(() => pinnedOfficialRelease({ ...releaseInput, officialZipSha256: "abc" }), /SHA-256/);
});

test("backup path stays beside Claude Official.app", () => {
  assert.equal(
    officialBackupPath("/Users/test/Applications", "2.7032.0", "20260928-050900"),
    "/Users/test/Applications/Claude Official.app.before-2.7032.0-20260928-050900",
  );
  assert.throws(() => officialBackupPath("/Users/test/Applications", "../Claude", "20260928-050900"), /version/);
});

test("replaces Official only after the zip, signature, and version match", async () => {
  const release = pinnedOfficialRelease(releaseInput);
  const calls = [];
  const renames = [];
  const result = await installPinnedOfficialApp({
    release,
    sourceApp: "/Users/test/Applications/Claude Official.app",
    stageRoot: "/tmp/claude-official-stage",
    stamp: "20260928-050900",
    fromVersion: "2.7032.0",
    sourceExists: true,
    downloadFile: async () => {},
    hashContents: async () => release.sha256,
    pathExists: async (path) => path.endsWith("Claude.app"),
    renamePath: async (from, to) => {
      renames.push([from, to]);
    },
    runCommand: (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("CFBundleShortVersionString")) return { status: 0, stdout: "2.9939.2\n", stderr: "" };
      if (args.includes("CFBundleIdentifier")) return { status: 0, stdout: "com.anthropic.claudefordesktop\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    mkdirPath: async () => {},
  });
  assert.deepEqual(renames, [[
    "/Users/test/Applications/Claude Official.app",
    "/Users/test/Applications/Claude Official.app.before-2.7032.0-20260928-050900",
  ]]);
  assert.equal(result.backupPath, renames[0][1]);
  assert.ok(calls.some((entry) => entry[0] === "/usr/bin/codesign" && entry.includes("--strict")));
  assert.ok(calls.some((entry) => entry[0] === "/usr/bin/spctl"));
  assert.equal(calls.filter((entry) => entry[0] === "/usr/bin/ditto").length, 2);
  assert.ok(calls.every((entry) => !entry.some((part) => String(part).includes("app.asar"))));
});

test("stops before moving Official when the zip hash does not match", async () => {
  const release = pinnedOfficialRelease(releaseInput);
  let renamed = false;
  await assert.rejects(() => installPinnedOfficialApp({
    release,
    sourceApp: "/Users/test/Applications/Claude Official.app",
    stageRoot: "/tmp/claude-official-stage",
    stamp: "20260928-050900",
    fromVersion: "2.7032.0",
    sourceExists: true,
    downloadFile: async () => {},
    hashContents: async () => "f".repeat(64),
    pathExists: async () => true,
    renamePath: async () => {
      renamed = true;
    },
    runCommand: () => {
      throw new Error("commands should not run");
    },
    mkdirPath: async () => {},
  }), /SHA-256/);
  assert.equal(renamed, false);
});

test("restores the previous Official app if the final copy fails", async () => {
  const release = pinnedOfficialRelease(releaseInput);
  const renames = [];
  let dittoCopies = 0;
  await assert.rejects(() => installPinnedOfficialApp({
    release,
    sourceApp: "/Users/test/Applications/Claude Official.app",
    stageRoot: "/tmp/claude-official-stage",
    stamp: "20260928-050900",
    fromVersion: "2.7032.0",
    sourceExists: true,
    downloadFile: async () => {},
    hashContents: async () => release.sha256,
    pathExists: async (path) => path.endsWith("Claude.app"),
    renamePath: async (from, to) => {
      renames.push([from, to]);
    },
    runCommand: (command, args) => {
      if (command === "/usr/bin/ditto" && args[0] !== "-xk") {
        dittoCopies += 1;
        return { status: 1, stdout: "", stderr: "copy failed" };
      }
      if (args.includes("CFBundleShortVersionString")) return { status: 0, stdout: "2.9939.2\n", stderr: "" };
      if (args.includes("CFBundleIdentifier")) return { status: 0, stdout: "com.anthropic.claudefordesktop\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    mkdirPath: async () => {},
  }), /ditto failed/);
  assert.equal(dittoCopies, 1);
  assert.deepEqual(renames, [
    [
      "/Users/test/Applications/Claude Official.app",
      "/Users/test/Applications/Claude Official.app.before-2.7032.0-20260928-050900",
    ],
    [
      "/Users/test/Applications/Claude Official.app.before-2.7032.0-20260928-050900",
      "/Users/test/Applications/Claude Official.app",
    ],
  ]);
});
