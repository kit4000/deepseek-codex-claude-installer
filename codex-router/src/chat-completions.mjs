import { Transform } from "node:stream";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textFromParts(content) {
  if (typeof content === "string") return content;
  return asArray(content)
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (typeof part?.text === "string") return [part.text];
      return [];
    })
    .join("\n");
}

function responsesToolsToChat(tools) {
  return asArray(tools).flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    if (tool.type === "function" && tool.function?.name) {
      return [{
        type: "function",
        function: {
          name: tool.function.name,
          description: tool.function.description ?? "",
          parameters: tool.function.parameters ?? { type: "object", properties: {} },
        },
      }];
    }
    const name = typeof tool.name === "string" && tool.name.length > 0 ? tool.name : undefined;
    if (!name) return [];
    return [{
      type: "function",
      function: {
        name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? tool.input_schema ?? { type: "object", properties: {} },
      },
    }];
  });
}

function mapToolChoice(choice) {
  if (!choice || choice === "auto" || choice.type === "auto") return "auto";
  if (choice === "required" || choice === "any" || choice.type === "any" || choice.type === "required") {
    return "required";
  }
  if (choice === "none" || choice.type === "none") return "none";
  const name = choice.name ?? choice.function?.name;
  if ((choice.type === "function" || choice.type === "tool") && name) {
    return { type: "function", function: { name } };
  }
  return undefined;
}

function mapReasoningEffort(effort, { dialect, model }) {
  if (dialect === "ollama"
    && /^qwen3\.8(?::|$)/i.test(model ?? "")
    && (effort === "high" || effort === "max")) {
    // This Qwen template calls its highest level "xhigh", while Ollama 0.32
    // normalizes that label back to "max" and the template rejects it. An
    // omitted effort selects the template's highest (xhigh) default.
    return undefined;
  }
  return effort;
}

function flushToolCalls(pending) {
  if (pending.length === 0) return undefined;
  const message = {
    role: "assistant",
    content: null,
    tool_calls: pending.map((call) => ({
      id: call.call_id,
      type: "function",
      function: {
        name: call.name,
        arguments: typeof call.arguments === "string" && call.arguments.length > 0
          ? call.arguments
          : "{}",
      },
    })),
  };
  pending.length = 0;
  return message;
}

export function responsesInputToChatMessages(input) {
  const messages = [];
  const pending = [];
  for (const item of asArray(input)) {
    if (item?.type === "function_call" || item?.type === "custom_tool_call" || item?.type === "local_shell_call") {
      pending.push({
        call_id: item.call_id,
        name: item.name
          ?? (item.type === "local_shell_call" ? "local_shell" : "tool"),
        arguments: typeof item.arguments === "string"
          ? item.arguments
          : (item.input != null ? JSON.stringify({ input: item.input }) : "{}"),
      });
      continue;
    }
    const flushed = flushToolCalls(pending);
    if (flushed) messages.push(flushed);
    if (item?.type === "function_call_output"
      || item?.type === "custom_tool_call_output"
      || item?.type === "local_shell_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : textFromParts(item.output),
      });
      continue;
    }
    if (item?.type === "message") {
      const text = textFromParts(item.content);
      messages.push({
        role: item.role === "assistant" ? "assistant" : "user",
        content: text,
      });
    }
  }
  const flushed = flushToolCalls(pending);
  if (flushed) messages.push(flushed);
  return messages;
}

export function responsesToChatCompletions(body, { model, dialect = "openai", keepAlive } = {}) {
  const messages = [];
  if (typeof body?.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }
  messages.push(...responsesInputToChatMessages(body?.input));
  const payload = {
    model,
    messages,
    stream: body?.stream !== false,
  };
  const tools = responsesToolsToChat(body?.tools);
  if (tools.length > 0) {
    payload.tools = tools;
    const toolChoice = mapToolChoice(body.tool_choice);
    if (toolChoice) payload.tool_choice = toolChoice;
  }
  const maxTokens = body?.max_output_tokens ?? body?.max_tokens;
  if (Number.isFinite(maxTokens)) {
    if (dialect === "ollama") payload.max_tokens = maxTokens;
    else payload.max_completion_tokens = maxTokens;
  }
  if (dialect === "ollama" && typeof keepAlive === "string" && keepAlive.length > 0) {
    // Keeps the model resident in the Ollama server between turns so only
    // the very first request in a while pays the cold-load cost.
    payload.keep_alive = keepAlive;
  }
  const effort = body?.reasoning?.effort ?? body?.reasoning_effort;
  if (typeof effort === "string" && effort.length > 0) {
    const mappedEffort = mapReasoningEffort(effort, { dialect, model });
    if (mappedEffort) payload.reasoning_effort = mappedEffort;
  }
  if (dialect !== "ollama" && payload.stream) payload.stream_options = { include_usage: true };
  return payload;
}

function usageFromChat(usage) {
  return {
    input_tokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens
      ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)),
  };
}

function formatSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

export function parseChatSseFrame(frame) {
  const trimmed = String(frame ?? "").replaceAll("\r", "").trim();
  if (!trimmed) return undefined;
  const dataLines = [];
  let sawData = false;
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) {
      sawData = true;
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = sawData ? dataLines.join("\n") : trimmed;
  if (!data) return undefined;
  if (data === "[DONE]") return { done: true };
  try {
    return { chunk: JSON.parse(data) };
  } catch {
    return undefined;
  }
}

function emptyResponse({ id, model, status = "in_progress" }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

export function chatMessageToResponsesOutput(message, finishReason) {
  const output = [];
  if (typeof message?.content === "string" && message.content.length > 0) {
    output.push({
      type: "message",
      id: "msg_chat_text",
      role: "assistant",
      content: [{ type: "output_text", text: message.content }],
    });
  }
  for (const call of asArray(message?.tool_calls)) {
    output.push({
      type: "function_call",
      id: call.id ?? `fc_${output.length}`,
      call_id: call.id,
      name: call.function?.name ?? "tool",
      arguments: call.function?.arguments ?? "{}",
    });
  }
  if (output.length === 0) {
    output.push({
      type: "message",
      id: "msg_chat_empty",
      role: "assistant",
      content: [{ type: "output_text", text: "" }],
    });
  }
  return {
    output,
    status: finishReason === "length" ? "incomplete" : "completed",
  };
}

export function chatCompletionsToResponses(chatBody, { requestModel, responseId } = {}) {
  const choice = chatBody?.choices?.[0] ?? {};
  const mapped = chatMessageToResponsesOutput(choice.message ?? {}, choice.finish_reason);
  const id = responseId ?? chatBody?.id ?? `resp_chat_${Date.now()}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: mapped.status,
    model: requestModel ?? chatBody?.model,
    output: mapped.output,
    usage: usageFromChat(chatBody?.usage),
  };
}

export function createChatToResponsesTranslator({ id, model }) {
  let sequence = 0;
  let textItemId;
  let textStarted = false;
  const toolCalls = new Map();
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const output = [];
  let finished = false;
  const events = [];

  function emit(type, data) {
    const payload = { type, sequence_number: sequence, ...data };
    sequence += 1;
    events.push(formatSse(type, payload));
    return payload;
  }

  function ensureText() {
    if (textStarted) return textItemId;
    textItemId = `${id}_msg`;
    textStarted = true;
    const item = {
      type: "message",
      id: textItemId,
      role: "assistant",
      content: [],
    };
    output.push(item);
    emit("response.output_item.added", {
      output_index: output.length - 1,
      item,
    });
    emit("response.content_part.added", {
      item_id: textItemId,
      output_index: output.length - 1,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    return textItemId;
  }

  function closeText() {
    if (!textStarted) return;
    const itemIndex = output.findIndex((item) => item.id === textItemId);
    const text = output[itemIndex]?.content?.[0]?.text ?? "";
    emit("response.output_text.done", {
      item_id: textItemId,
      output_index: itemIndex,
      content_index: 0,
      text,
    });
    emit("response.content_part.done", {
      item_id: textItemId,
      output_index: itemIndex,
      content_index: 0,
      part: { type: "output_text", text },
    });
    emit("response.output_item.done", {
      output_index: itemIndex,
      item: output[itemIndex],
    });
    textStarted = false;
  }

  function ensureTool(openaiIndex, call) {
    let state = toolCalls.get(openaiIndex);
    if (state) return state;
    closeText();
    const callId = call.id ?? `call_chat_${openaiIndex}`;
    const item = {
      type: "function_call",
      id: `${id}_fc_${openaiIndex}`,
      call_id: callId,
      name: call.function?.name ?? call.name ?? "tool",
      arguments: "",
    };
    output.push(item);
    state = { item, outputIndex: output.length - 1 };
    toolCalls.set(openaiIndex, state);
    emit("response.output_item.added", {
      output_index: state.outputIndex,
      item,
    });
    return state;
  }

  return {
    start() {
      emit("response.created", { response: emptyResponse({ id, model }) });
      emit("response.in_progress", { response: emptyResponse({ id, model }) });
      return events.splice(0);
    },
    pushChunk(chunk) {
      if (finished || !chunk) return [];
      const choice = chunk.choices?.[0] ?? {};
      const delta = choice.delta ?? {};
      if (chunk.usage) usage = usageFromChat(chunk.usage);
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const itemId = ensureText();
        const itemIndex = output.findIndex((item) => item.id === itemId);
        const part = output[itemIndex].content[0] ?? { type: "output_text", text: "" };
        part.text = `${part.text ?? ""}${delta.content}`;
        output[itemIndex].content[0] = part;
        emit("response.output_text.delta", {
          item_id: itemId,
          output_index: itemIndex,
          content_index: 0,
          delta: delta.content,
        });
      }
      for (const call of asArray(delta.tool_calls)) {
        const state = ensureTool(call.index ?? 0, call);
        const fragment = call.function?.arguments ?? "";
        if (typeof fragment === "string" && fragment.length > 0) {
          state.item.arguments += fragment;
          emit("response.function_call_arguments.delta", {
            item_id: state.item.id,
            output_index: state.outputIndex,
            delta: fragment,
          });
        }
        if (typeof call.id === "string" && call.id.length > 0) state.item.call_id = call.id;
        if (typeof call.function?.name === "string" && call.function.name.length > 0) {
          state.item.name = call.function.name;
        }
      }
      return events.splice(0);
    },
    finish() {
      if (finished) return [];
      finished = true;
      closeText();
      for (const state of toolCalls.values()) {
        emit("response.function_call_arguments.done", {
          item_id: state.item.id,
          output_index: state.outputIndex,
          arguments: state.item.arguments,
        });
        emit("response.output_item.done", {
          output_index: state.outputIndex,
          item: state.item,
        });
      }
      const response = {
        ...emptyResponse({ id, model, status: "completed" }),
        output: structuredClone(output),
        usage,
      };
      emit("response.completed", { response });
      return events.splice(0);
    },
  };
}

export function createChatToResponsesTransform({ id, model, translator: existingTranslator }) {
  const translator = existingTranslator ?? createChatToResponsesTranslator({ id, model });
  let buffer = "";
  let started = existingTranslator !== undefined;
  let closed = false;

  function pushEvents(stream, frames) {
    for (const event of frames) stream.push(event);
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (!started) {
          started = true;
          pushEvents(this, translator.start());
        }
        buffer += chunk.toString("utf8");
        const split = splitSseFrames(buffer);
        buffer = split.remaining;
        for (const frame of split.frames) {
          const parsed = parseChatSseFrame(frame);
          if (!parsed) continue;
          if (parsed.done) {
            if (!closed) {
              closed = true;
              pushEvents(this, translator.finish());
            }
            continue;
          }
          pushEvents(this, translator.pushChunk(parsed.chunk));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        if (!started) {
          started = true;
          pushEvents(this, translator.start());
        }
        if (buffer.trim()) {
          const parsed = parseChatSseFrame(buffer);
          if (parsed?.chunk) pushEvents(this, translator.pushChunk(parsed.chunk));
          if (parsed?.done && !closed) {
            closed = true;
            pushEvents(this, translator.finish());
          }
        }
        if (!closed) {
          closed = true;
          pushEvents(this, translator.finish());
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}
