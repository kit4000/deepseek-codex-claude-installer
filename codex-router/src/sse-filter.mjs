import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

const REASONING_CONTENT_EVENTS = new Set([
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
]);

function withoutReasoningContent(item) {
  if (item?.type !== "reasoning" || !Array.isArray(item.content) || item.content.length === 0) {
    return item;
  }
  return { ...item, content: [] };
}

function withoutResponseReasoningContent(response) {
  if (!Array.isArray(response?.output)) return response;
  return {
    ...response,
    output: response.output.map(withoutReasoningContent),
  };
}

export function filterReasoningContentEvent(event, state) {
  if (!event || typeof event !== "object") return event;
  if (REASONING_CONTENT_EVENTS.has(event.type)) return null;
  if ((event.type === "response.content_part.added" || event.type === "response.content_part.done")
    && event.part?.type === "reasoning_text") {
    return null;
  }

  const filtered = structuredClone(event);
  if (filtered.item) filtered.item = withoutReasoningContent(filtered.item);
  if (filtered.response) {
    filtered.response = withoutResponseReasoningContent(filtered.response);
  }
  if (Number.isInteger(filtered.sequence_number)) {
    filtered.sequence_number = state.nextSequenceNumber;
    state.nextSequenceNumber += 1;
  }
  return filtered;
}

function parseFrameData(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function encodeFrame(event, delimiter) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}${delimiter}`;
}

function withMessagePhase(event, messageId, phase) {
  if (!phase) return event;
  const normalized = structuredClone(event);
  if (normalized.item?.type === "message" && normalized.item.id === messageId) {
    normalized.item.phase = phase;
  }
  if (Array.isArray(normalized.response?.output)) {
    normalized.response.output = normalized.response.output.map((item) => (
      item?.type === "message" && item.id === messageId ? { ...item, phase } : item
    ));
  }
  return normalized;
}

export class ReasoningContentFilter extends Transform {
  constructor({ stabilizeMessagePhase = false, messageBufferCharacters = 1024 } = {}) {
    super();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.state = { nextSequenceNumber: 0 };
    this.stabilizeMessagePhase = stabilizeMessagePhase;
    this.messageBufferCharacters = messageBufferCharacters;
    this.messagePhases = new Map();
    this.pendingMessage = undefined;
  }

  writeEvent(event, delimiter) {
    this.push(encodeFrame(event, delimiter));
  }

  knownMessagePhase(event) {
    let normalized = event;
    for (const [messageId, phase] of this.messagePhases) {
      normalized = withMessagePhase(normalized, messageId, phase);
    }
    return normalized;
  }

  finishPendingMessage(phase) {
    const pending = this.pendingMessage;
    if (!pending) return;
    const stablePhase = phase ?? pending.initialPhase ?? "final_answer";
    this.messagePhases.set(pending.id, stablePhase);
    for (const entry of pending.entries) {
      if (entry.raw !== undefined) {
        this.push(entry.raw);
      } else {
        this.writeEvent(withMessagePhase(entry.event, pending.id, stablePhase), entry.delimiter);
      }
    }
    this.pendingMessage = undefined;
  }

  handleStableMessagePhase(event, delimiter) {
    const normalized = this.knownMessagePhase(event);
    if (!this.stabilizeMessagePhase) {
      this.writeEvent(normalized, delimiter);
      return;
    }

    if (!this.pendingMessage) {
      if (normalized.type === "response.output_item.added"
        && normalized.item?.type === "message"
        && normalized.item.phase !== "commentary") {
        this.pendingMessage = {
          id: normalized.item.id,
          outputIndex: normalized.output_index,
          initialPhase: normalized.item.phase,
          characters: 0,
          entries: [{ event: normalized, delimiter }],
        };
        return;
      }
      this.writeEvent(normalized, delimiter);
      return;
    }

    const pending = this.pendingMessage;
    pending.entries.push({ event: normalized, delimiter });
    if (normalized.type === "response.output_text.delta"
      && (normalized.item_id === pending.id || normalized.output_index === pending.outputIndex)) {
      pending.characters += normalized.delta?.length ?? 0;
    }

    if (normalized.type === "response.output_item.done"
      && normalized.item?.type === "message"
      && normalized.item.id === pending.id) {
      this.finishPendingMessage(normalized.item.phase);
      return;
    }

    if (normalized.type === "response.completed") {
      const completed = normalized.response?.output?.find((item) => item?.id === pending.id);
      this.finishPendingMessage(completed?.phase);
      return;
    }

    if (normalized.type === "response.output_item.added"
      && ["function_call", "custom_tool_call", "local_shell_call"].includes(normalized.item?.type)) {
      this.finishPendingMessage("commentary");
      return;
    }

    if (pending.characters >= this.messageBufferCharacters) {
      // Long messages are overwhelmingly final answers. Release them after a
      // bounded prefix so normal final-answer streaming is not delayed.
      this.finishPendingMessage("final_answer");
    }
  }

  handleFrame(frame, delimiter) {
    const event = parseFrameData(frame);
    if (!event) {
      if (this.pendingMessage) {
        this.pendingMessage.entries.push({ raw: `${frame}${delimiter}` });
      } else {
        this.push(`${frame}${delimiter}`);
      }
      return;
    }
    const filtered = filterReasoningContentEvent(event, this.state);
    if (filtered) this.handleStableMessagePhase(filtered, delimiter);
  }

  drainFrames() {
    while (this.buffer.length > 0) {
      const separator = this.buffer.match(/\r?\n\r?\n/);
      if (!separator) return;
      const frame = this.buffer.slice(0, separator.index);
      const delimiter = separator[0];
      this.buffer = this.buffer.slice(separator.index + delimiter.length);
      this.handleFrame(frame, delimiter);
    }
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.buffer += this.decoder.write(chunk);
      this.drainFrames();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      this.buffer += this.decoder.end();
      this.drainFrames();
      if (this.buffer) {
        this.handleFrame(this.buffer, "");
      }
      this.finishPendingMessage();
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

export function createReasoningContentFilter(options) {
  return new ReasoningContentFilter(options);
}
