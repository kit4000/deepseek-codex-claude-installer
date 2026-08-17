import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicToOpenAIChatCompletions,
  createOpenAIToAnthropicStreamTranslator,
  openaiChatToAnthropicMessage,
  openaiErrorToAnthropic,
  parseOpenAISseFrame,
  splitSseFrames,
} from "../src/openai-messages.mjs";

test("maps Anthropic messages, tools, and effort onto Chat Completions", () => {
  const payload = anthropicToOpenAIChatCompletions({
    model: "claude-opus-4-5",
    max_tokens: 128,
    stream: true,
    output_config: { effort: "high" },
    system: [{ type: "text", text: "Be brief." }],
    tools: [{
      name: "Bash",
      description: "Run a shell command",
      input_schema: { type: "object", properties: { command: { type: "string" } } },
    }],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "pwd" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: "/tmp" },
          { type: "text", text: "continue" },
        ],
      },
    ],
  }, "gpt-5.6-sol");

  assert.equal(payload.model, "gpt-5.6-sol");
  assert.equal(payload.stream, true);
  assert.equal(payload.max_completion_tokens, 128);
  assert.equal(payload.reasoning_effort, "high");
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[1].content, "hi");
  assert.equal(payload.messages[2].tool_calls[0].id, "tool_1");
  assert.equal(payload.messages[3].role, "tool");
  assert.equal(payload.messages[3].tool_call_id, "tool_1");
  assert.equal(payload.messages[4].content, "continue");
  assert.equal(payload.tools[0].function.name, "Bash");
  assert.deepEqual(payload.stream_options, { include_usage: true });
});

test("converts a non-stream OpenAI chat response back to Anthropic", () => {
  const message = openaiChatToAnthropicMessage({
    id: "chatcmpl-1",
    usage: { prompt_tokens: 9, completion_tokens: 4 },
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" },
        }],
      },
    }],
  }, "claude-opus-4-5");

  assert.equal(message.model, "claude-opus-4-5");
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content[0].type, "tool_use");
  assert.equal(message.content[0].name, "Bash");
  assert.deepEqual(message.content[0].input, { command: "pwd" });
  assert.equal(message.usage.input_tokens, 9);
});

test("translates an OpenAI token stream into Anthropic SSE", () => {
  const translator = createOpenAIToAnthropicStreamTranslator({
    id: "msg_test",
    model: "claude-sonnet-4-5",
  });
  const start = translator.start().join("");
  const deltas = [
    ...translator.pushChunk({ choices: [{ delta: { content: "Hel" } }] }),
    ...translator.pushChunk({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  ].join("");
  const end = translator.finish().join("");
  assert.match(start, /event: message_start/);
  assert.match(deltas, /"text":"Hel"/);
  assert.match(deltas, /"text":"lo"/);
  assert.match(end, /"stop_reason":"end_turn"/);
  assert.match(end, /event: message_stop/);
});

test("parses split OpenAI SSE frames", () => {
  const first = splitSseFrames("data: {\"a\":1}\n\ndata: {\"b\"");
  assert.equal(first.frames.length, 1);
  assert.deepEqual(parseOpenAISseFrame(first.frames[0]), { chunk: { a: 1 } });
  const second = splitSseFrames(`${first.remaining}:2}\n\ndata: [DONE]\n\n`);
  assert.deepEqual(parseOpenAISseFrame(second.frames[0]), { chunk: { b: 2 } });
  assert.deepEqual(parseOpenAISseFrame(second.frames[1]), { done: true });
});

test("maps OpenAI errors without exposing credentials", () => {
  const mapped = openaiErrorToAnthropic(401, JSON.stringify({ error: { message: "Incorrect API key provided" } }));
  assert.equal(mapped.status, 401);
  assert.equal(mapped.payload.error.type, "api_error");
  assert.match(mapped.payload.error.message, /Incorrect API key/);
  assert.doesNotMatch(JSON.stringify(mapped), /\bsk-[A-Za-z0-9_-]{20,}\b/);
});
