import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createReasoningContentFilter } from "../src/sse-filter.mjs";

function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseEvents(payload) {
  return payload
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => JSON.parse(
      block.split(/\r?\n/).find((line) => line.startsWith("data:")).slice(5).trimStart(),
    ));
}

async function filterChunks(chunks, options) {
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(createReasoningContentFilter(options))) {
    output.push(chunk);
  }
  return Buffer.concat(output).toString("utf8");
}

test("removes DeepSeek raw reasoning redraws while preserving commentary", async () => {
  const reasoning = {
    type: "reasoning",
    id: "reasoning-1",
    status: "completed",
    content: [{ type: "reasoning_text", text: "private chain of thought" }],
    summary: [],
  };
  const commentary = {
    type: "message",
    id: "message-1",
    role: "assistant",
    phase: "commentary",
    status: "completed",
    content: [{ type: "output_text", text: "最新の進捗です", annotations: [] }],
  };
  const payload = [
    frame({ type: "response.created", response: { id: "response-1", output: [] }, sequence_number: 0 }),
    frame({ type: "response.output_item.added", item: { ...reasoning, status: "in_progress", content: [] }, output_index: 0, sequence_number: 1 }),
    frame({ type: "response.content_part.added", part: { type: "reasoning_text", text: "" }, output_index: 0, content_index: 0, sequence_number: 2 }),
    frame({ type: "response.reasoning_text.delta", delta: "private ", output_index: 0, content_index: 0, sequence_number: 3 }),
    frame({ type: "response.reasoning_text.done", text: "private chain of thought", output_index: 0, content_index: 0, sequence_number: 4 }),
    frame({ type: "response.content_part.done", part: reasoning.content[0], output_index: 0, content_index: 0, sequence_number: 5 }),
    frame({ type: "response.output_item.done", item: reasoning, output_index: 0, sequence_number: 6 }),
    frame({ type: "response.output_item.added", item: { ...commentary, status: "in_progress", content: [] }, output_index: 1, sequence_number: 7 }),
    frame({ type: "response.output_text.delta", delta: "最新の進捗です", output_index: 1, content_index: 0, sequence_number: 8 }),
    frame({ type: "response.completed", response: { id: "response-1", output: [reasoning, commentary] }, sequence_number: 9 }),
  ].join("");
  const bytes = Buffer.from(payload);
  const filteredPayload = await filterChunks([
    bytes.subarray(0, 17),
    bytes.subarray(17, 211),
    bytes.subarray(211, 517),
    bytes.subarray(517),
  ], { stabilizeMessagePhase: true });
  const events = parseEvents(filteredPayload);

  assert.equal(filteredPayload.includes("private chain of thought"), false);
  assert.equal(filteredPayload.includes("最新の進捗です"), true);
  assert.deepEqual(events.map((event) => event.sequence_number), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_item.added",
    "response.output_text.delta",
    "response.completed",
  ]);
  assert.deepEqual(events[2].item.content, []);
  assert.equal(events[3].item.phase, "commentary");
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output[1].phase, "commentary");
});

test("keeps long final answers streaming with one stable phase", async () => {
  const message = {
    type: "message",
    id: "message-final",
    role: "assistant",
    phase: "final_answer",
    status: "in_progress",
    content: [],
  };
  const payload = [
    frame({ type: "response.output_item.added", item: message, output_index: 0, sequence_number: 0 }),
    frame({ type: "response.output_text.delta", item_id: message.id, delta: "long final answer", output_index: 0, content_index: 0, sequence_number: 1 }),
    frame({ type: "response.output_item.done", item: { ...message, status: "completed", phase: "commentary" }, output_index: 0, sequence_number: 2 }),
  ].join("");
  const filtered = await filterChunks([payload], {
    stabilizeMessagePhase: true,
    messageBufferCharacters: 4,
  });
  const events = parseEvents(filtered);

  assert.equal(events[0].item.phase, "final_answer");
  assert.equal(events[2].item.phase, "final_answer");
});

test("passes non-JSON SSE frames through without changing their payload", async () => {
  const payload = ": keep-alive\n\ndata: [DONE]\n\n";
  assert.equal(await filterChunks([payload]), payload);
});
