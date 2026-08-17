const EFFORT_MAP = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textFromBlocks(content) {
  if (typeof content === "string") return content;
  return asArray(content)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function thinkingFromBlocks(content) {
  return asArray(content)
    .filter((block) => (block?.type === "thinking" || block?.type === "redacted_thinking") && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("\n");
}

function systemText(system) {
  if (typeof system === "string") return system;
  return asArray(system)
    .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
    .filter(Boolean)
    .join("\n");
}

function mapEffort(body) {
  const candidates = [
    body?.output_config?.effort,
    body?.thinking?.effort,
    body?.effort,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && EFFORT_MAP[value]) return EFFORT_MAP[value];
  }
  if (body?.thinking && body.thinking.type !== "disabled") return "high";
  return "medium";
}

function openaiToolFromAnthropic(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema ?? { type: "object", properties: {} },
    },
  };
}

function mapToolChoice(choice) {
  if (!choice || choice === "auto" || choice.type === "auto") return "auto";
  if (choice === "any" || choice.type === "any") return "required";
  if (choice === "none" || choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function userContentToOpenAI(content) {
  if (typeof content === "string") return content;
  const parts = [];
  for (const block of asArray(content)) {
    if (block?.type === "text" && block.text) {
      parts.push({ type: "text", text: block.text });
    } else if (block?.type === "image" && block.source?.type === "base64") {
      const media = block.source.media_type ?? "image/png";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${media};base64,${block.source.data}` },
      });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function assistantMessageToOpenAI(content) {
  const text = textFromBlocks(content);
  const thinking = thinkingFromBlocks(content);
  const toolUses = asArray(content).filter((block) => block?.type === "tool_use");
  const message = { role: "assistant", content: text || null };
  if (thinking) message.reasoning_content = thinking;
  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));
  }
  return message;
}

export function anthropicToOpenAIChatCompletions(body, targetModel) {
  if (!body || typeof body !== "object") {
    throw new Error("Expected an Anthropic Messages request body");
  }
  const messages = [];
  const system = systemText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of asArray(body.messages)) {
    if (message.role === "assistant") {
      messages.push(assistantMessageToOpenAI(message.content));
      continue;
    }
    const toolResults = asArray(message.content).filter((block) => block?.type === "tool_result");
    for (const result of toolResults) {
      const content = typeof result.content === "string"
        ? result.content
        : textFromBlocks(result.content);
      messages.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: content || "",
      });
    }
    const remaining = asArray(message.content).filter((block) => block?.type !== "tool_result");
    if (typeof message.content === "string" || remaining.length > 0) {
      const content = typeof message.content === "string"
        ? message.content
        : userContentToOpenAI(remaining);
      if (content !== "" && !(Array.isArray(content) && content.length === 0)) {
        messages.push({ role: "user", content });
      }
    }
  }

  const payload = {
    model: targetModel,
    messages,
    stream: Boolean(body.stream),
    reasoning_effort: mapEffort(body),
  };
  if (body.stream) payload.stream_options = { include_usage: true };
  const maxTokens = body.max_tokens ?? body.max_output_tokens;
  if (Number.isFinite(maxTokens)) payload.max_completion_tokens = maxTokens;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools.map(openaiToolFromAnthropic);
    const toolChoice = mapToolChoice(body.tool_choice);
    if (toolChoice) payload.tool_choice = toolChoice;
  }
  return payload;
}

function stopReasonFromFinish(finishReason, hasTools) {
  if (finishReason === "tool_calls" || hasTools) return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

function usageFromOpenAI(usage) {
  return {
    input_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
  };
}

export function openaiChatToAnthropicMessage(openaiBody, requestModel) {
  const choice = openaiBody?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  const reasoning = message.reasoning_content ?? message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of asArray(message.tool_calls)) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: openaiBody.id ? `msg_${openaiBody.id}` : `msg_openai_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestModel,
    content,
    stop_reason: stopReasonFromFinish(choice.finish_reason, asArray(message.tool_calls).length > 0),
    stop_sequence: null,
    usage: usageFromOpenAI(openaiBody.usage),
  };
}

export function formatSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createOpenAIToAnthropicStreamTranslator({ id, model }) {
  let nextIndex = 0;
  let textIndex;
  let thinkingIndex;
  const toolIndexByOpenai = new Map();
  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const events = [];

  function emit(event, data) {
    events.push(formatSse(event, data));
  }

  function closeBlock(index) {
    if (index === undefined) return;
    emit("content_block_stop", { type: "content_block_stop", index });
  }

  function ensureText() {
    if (thinkingIndex !== undefined) {
      closeBlock(thinkingIndex);
      thinkingIndex = undefined;
    }
    if (textIndex === undefined) {
      textIndex = nextIndex;
      nextIndex += 1;
      emit("content_block_start", {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" },
      });
    }
    return textIndex;
  }

  function ensureThinking() {
    if (thinkingIndex === undefined) {
      thinkingIndex = nextIndex;
      nextIndex += 1;
      emit("content_block_start", {
        type: "content_block_start",
        index: thinkingIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }
    return thinkingIndex;
  }

  function ensureTool(openaiIndex, call) {
    if (textIndex !== undefined) {
      closeBlock(textIndex);
      textIndex = undefined;
    }
    if (thinkingIndex !== undefined) {
      closeBlock(thinkingIndex);
      thinkingIndex = undefined;
    }
    let index = toolIndexByOpenai.get(openaiIndex);
    if (index === undefined) {
      index = nextIndex;
      nextIndex += 1;
      toolIndexByOpenai.set(openaiIndex, index);
      emit("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: call.id,
          name: call.function?.name,
          input: {},
        },
      });
    }
    return index;
  }

  return {
    start() {
      emit("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      return events.splice(0);
    },
    pushChunk(chunk) {
      const choice = chunk?.choices?.[0] ?? {};
      const delta = choice.delta ?? {};
      if (chunk.usage) usage = usageFromOpenAI(chunk.usage);
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        const index = ensureThinking();
        emit("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const index = ensureText();
        emit("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      for (const call of asArray(delta.tool_calls)) {
        stopReason = "tool_use";
        const index = ensureTool(call.index ?? 0, call);
        if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
          emit("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: call.function.arguments },
          });
        }
      }
      if (choice.finish_reason) {
        stopReason = stopReasonFromFinish(choice.finish_reason, toolIndexByOpenai.size > 0);
      }
      return events.splice(0);
    },
    finish() {
      closeBlock(thinkingIndex);
      closeBlock(textIndex);
      for (const index of toolIndexByOpenai.values()) closeBlock(index);
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      });
      emit("message_stop", { type: "message_stop" });
      return events.splice(0);
    },
  };
}

export function splitSseFrames(buffer) {
  const frames = [];
  let remaining = buffer;
  while (true) {
    const boundary = remaining.indexOf("\n\n");
    if (boundary === -1) break;
    frames.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary + 2);
  }
  return { frames, remaining };
}

export function parseOpenAISseFrame(frame) {
  const lines = frame.split("\n");
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join("\n");
  if (!data) return undefined;
  if (data === "[DONE]") return { done: true };
  try {
    return { chunk: JSON.parse(data) };
  } catch {
    return undefined;
  }
}

export function openaiErrorToAnthropic(status, body) {
  let message = "OpenAI request failed";
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    message = parsed?.error?.message ?? message;
  } catch {}
  return {
    status,
    payload: {
      error: {
        type: "api_error",
        message,
      },
    },
  };
}
