import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import test from "node:test";
import {
  chatCompletionsToResponses,
  createChatToResponsesTransform,
  createChatToResponsesTranslator,
  parseChatSseFrame,
  responsesInputToChatMessages,
  responsesToChatCompletions,
  splitSseFrames,
} from "../src/chat-completions.mjs";

test("maps Responses input, tools, and instructions onto Ollama Chat Completions", () => {
  const payload = responsesToChatCompletions({
    model: "qwen/qwen-3.8-2.7b",
    instructions: "You are Codex.",
    stream: true,
    reasoning: { effort: "max" },
    max_output_tokens: 64,
    tools: [{
      type: "function",
      name: "shell",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"command\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_1", output: "/tmp" },
    ],
  }, { model: "qwen3.8:27b", dialect: "ollama" });

  assert.equal(payload.model, "qwen3.8:27b");
  assert.equal(payload.stream, true);
  assert.equal(payload.max_tokens, 64);
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.stream_options, undefined);
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[1].content, "hi");
  assert.equal(payload.messages[2].tool_calls[0].id, "call_1");
  assert.equal(payload.messages[3].role, "tool");
  assert.equal(payload.tools[0].function.name, "shell");
});

test("uses Qwen's highest default for Codex high and max efforts", () => {
  for (const effort of ["high", "max"]) {
    const payload = responsesToChatCompletions({
      reasoning: { effort },
      input: [],
    }, { model: "qwen3.8:27b", dialect: "ollama" });
    assert.equal(payload.reasoning_effort, undefined);
  }
});

test("batches consecutive tool calls into one assistant message", () => {
  const messages = responsesInputToChatMessages([
    { type: "function_call", call_id: "a", name: "one", arguments: "{}" },
    { type: "function_call", call_id: "b", name: "two", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "1" },
    { type: "function_call_output", call_id: "b", output: "2" },
  ]);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].tool_calls.length, 2);
  assert.equal(messages[1].tool_call_id, "a");
  assert.equal(messages[2].tool_call_id, "b");
});

test("converts a non-stream Chat Completions response back to Responses", () => {
  const response = chatCompletionsToResponses({
    id: "chatcmpl-1",
    usage: { prompt_tokens: 4, completion_tokens: 2 },
    choices: [{
      finish_reason: "stop",
      message: { content: "hello from qwen" },
    }],
  }, { requestModel: "qwen/qwen-3.8-2.7b", responseId: "resp_test" });
  assert.equal(response.id, "resp_test");
  assert.equal(response.status, "completed");
  assert.equal(response.output[0].content[0].text, "hello from qwen");
  assert.equal(response.usage.input_tokens, 4);
});

test("translates a Chat Completions token stream into Responses SSE", () => {
  const translator = createChatToResponsesTranslator({
    id: "resp_stream",
    model: "qwen/qwen-3.8-2.7b",
  });
  const start = translator.start().join("");
  const deltas = [
    ...translator.pushChunk({ choices: [{ delta: { content: "Hel" } }] }),
    ...translator.pushChunk({
      choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  ].join("");
  const end = translator.finish().join("");
  assert.match(start, /event: response.created/);
  assert.match(deltas, /"delta":"Hel"/);
  assert.match(deltas, /"delta":"lo"/);
  assert.match(end, /event: response.completed/);
  assert.match(end, /"status":"completed"/);
});

test("parses split Chat Completions SSE frames", () => {
  const first = splitSseFrames("data: {\"a\":1}\n\ndata: {\"b\"");
  assert.equal(first.frames.length, 1);
  assert.deepEqual(parseChatSseFrame(first.frames[0]), { chunk: { a: 1 } });
  const second = splitSseFrames(`${first.remaining}:2}\n\ndata: [DONE]\n\n`);
  assert.deepEqual(parseChatSseFrame(second.frames[0]), { chunk: { b: 2 } });
  assert.deepEqual(parseChatSseFrame(second.frames[1]), { done: true });
});

test("transform converts a Chat Completions SSE body into Responses events", async () => {
  const transform = createChatToResponsesTransform({
    id: "resp_transform",
    model: "qwen/qwen-3.8-2.7b",
  });
  const upstream = Readable.from([
    "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
    "data: [DONE]\n\n",
  ]);
  const payload = await text(upstream.pipe(transform));
  assert.match(payload, /event: response.created/);
  assert.match(payload, /"delta":"ok"/);
  assert.match(payload, /event: response.completed/);
  assert.equal((payload.match(/event: response.completed/g) ?? []).length, 1);
});
