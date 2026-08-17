export function decideClaudeHybridUpdate(state, mode = "check") {
  const artifacts = {
    sourceApp: state.sourceApp,
    targetApp: state.targetApp,
    sourceVersion: state.sourceVersion,
    sourceBuild: state.sourceBuild,
    targetVersion: state.targetVersion ?? null,
    targetBuild: state.targetBuild ?? null,
    installedPatchVersion: state.installedPatchVersion ?? null,
    expectedPatchVersion: state.expectedPatchVersion,
  };

  if (!state.sourceSignatureValid) {
    return {
      status: "error",
      summary: "Claude source signature verification failed.",
      root_cause_hint: "The configured source app is missing, damaged, or not an official signed build.",
      next_actions: ["Install or replace ~/Applications/Claude Official.app with a pristine Apple-signed build, then run --check again."],
      artifacts,
    };
  }
  if (!state.environmentAnchorPresent || !state.labelAnchorPresent) {
    return {
      status: "error",
      summary: "This Claude build is not compatible with the current Hybrid patch anchors.",
      root_cause_hint: "Claude changed its bundled JavaScript layout; fuzzy patching is intentionally disabled.",
      next_actions: ["Update the installer source and regression tests for this Claude version before applying."],
      artifacts,
    };
  }

  const upToDate = state.targetExists
    && state.sourceVersion === state.targetVersion
    && state.sourceBuild === state.targetBuild
    && state.installedPatchVersion === state.expectedPatchVersion
    && state.targetPatchCompatible;
  if (upToDate) {
    return {
      status: "success",
      summary: "Claude Hybrid is already up to date.",
      next_actions: ["Run the non-billable verifier if UI behavior needs confirmation."],
      artifacts,
    };
  }
  const metadataMigrationAvailable = state.targetExists
    && state.sourceVersion === state.targetVersion
    && state.sourceBuild === state.targetBuild
    && state.installedPatchVersion !== state.expectedPatchVersion
    && state.targetPatchCompatible;
  if (mode === "apply" && state.claudeRunning) {
    return {
      status: "warning",
      summary: "Claude is running; the Hybrid update was not applied.",
      root_cause_hint: "Replacing an Electron app while Claude or Claude Hybrid is running is unsafe.",
      next_actions: ["Ask the user to fully quit both Claude apps, then rerun with --apply."],
      artifacts,
    };
  }
  if (mode === "apply" && !state.credentialAvailable) {
    return {
      status: "error",
      summary: "DeepSeek credential is unavailable in this user's Keychain.",
      root_cause_hint: "Credentials are never copied from another machine or included in the installer.",
      next_actions: ["Run the installer store-key command as the target user, then retry --apply."],
      artifacts,
    };
  }
  if (mode === "apply" && state.openaiRequired === true && state.openaiCredentialAvailable === false) {
    return {
      status: "error",
      summary: "OpenAI credential is unavailable in this user's Keychain.",
      root_cause_hint: "Credentials are never copied from another machine or included in the installer.",
      next_actions: ["Run npm run store-openai-key as the target user, then retry --apply."],
      artifacts,
    };
  }
  return {
    status: "warning",
    summary: metadataMigrationAvailable
      ? "A verified Claude Hybrid metadata migration is available."
      : state.targetExists ? "A Claude Hybrid rebuild is available." : "Claude Hybrid is not installed yet.",
    next_actions: mode === "apply"
      ? [metadataMigrationAvailable
        ? "Apply the metadata-only migration and run the non-billable verifier."
        : "Apply the verified rebuild and run the non-billable verifier."]
      : ["Fully quit both Claude apps, then rerun with --apply."],
    artifacts: { ...artifacts, updateKind: metadataMigrationAvailable ? "metadata-migration" : "rebuild" },
  };
}
