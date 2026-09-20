/**
 * The agent session.
 *
 * Uses STREAMING INPUT mode (an async generator of SDKUserMessage) rather than
 * `query({prompt: string})`. That is not a style choice: the string form cannot
 * carry image blocks, and half the graded questions are "here is a photo of my
 * weld, what is wrong with it". Streaming input is the only path that accepts
 * one.
 *
 * Note the two different image shapes, which is an easy and silent thing to get
 * wrong:
 *   - INTO the agent (here):  {type:"image", source:{type:"base64", media_type, data}}
 *   - OUT of a tool (tools.ts): {type:"image", data, mimeType}
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { omniproServer, ALLOWED_TOOLS } from "./tools.js";
import { drainDiagrams, drainWidgets } from "../../diagram/src/svg.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { loadEnv } from "./preflight.js";
import { checkAnswer, type AnswerCheck } from "./answercheck.js";

// The SDK subprocess inherits process.env, so .env must be loaded before any query.
loadEnv();

export const MODEL = "claude-opus-5";

export interface Attachment {
  /** Raw base64, no data: prefix. */
  data: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface Turn {
  text: string;
  images?: Attachment[];
}

export interface ToolCall {
  name: string;
  input: unknown;
  /** Present once the matching result comes back. */
  isError?: boolean;
  /** Rejection detail, when the tool refused. */
  error?: string;
}

export interface AgentResult {
  text: string;
  /** Ordered trace of tool calls -- the eval suite asserts on this, not on prose. */
  toolCalls: ToolCall[];
  /** Every SVG the agent had rendered, in order. */
  svgs: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  costUsd?: number;
  /**
   * Deterministic audit of every number in the prose, run after the fact with no
   * model involved. Diagrams and widgets are verified before they can exist;
   * this is the only gate on free text, which is the one surface where the model
   * can still put a number of its own choosing in front of the user.
   */
  numbers: AnswerCheck;
}

function toUserMessage(turn: Turn): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  for (const img of turn.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  content.push({ type: "text", text: turn.text });

  return {
    type: "user",
    message: { role: "user", content: content as never },
    parent_tool_use_id: null,
  };
}

export interface AskOptions {
  model?: string;
  /** Raise for the eval suite; the default keeps a stray loop from burning budget. */
  maxTurns?: number;
}

/**
 * Events emitted while the agent works.
 *
 * A static answer that lands 40 seconds later reads as broken -- users have been
 * trained by every current assistant to expect text arriving as it is produced.
 * Streaming also lets the tool trace surface live, which turns dead air into the
 * system visibly consulting the manual.
 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; phase: "start" }
  | { type: "tool"; name: string; phase: "ok" | "rejected"; detail?: string }
  | { type: "diagram"; svg: string; title: string; subtitle?: string }
  | { type: "widget"; payload: unknown }
  | { type: "figure"; id: string; page: number }
  | { type: "numbers"; check: AnswerCheck }
  | { type: "done"; result: AgentResult };

export type OnEvent = (e: AgentEvent) => void;

/**
 * Run one question (optionally with photos) to completion.
 *
 * Returns the trace as well as the prose, because the trace is what we grade:
 * "did it call get_duty_cycle before answering" is a deterministic assertion,
 * while "does the paragraph read well" is not.
 */
export async function ask(
  turn: Turn,
  opts: AskOptions = {},
  onEvent?: OnEvent,
): Promise<AgentResult> {
  const emit: OnEvent = onEvent ?? (() => {});

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield toUserMessage(turn);
  }

  const toolCalls: ToolCall[] = [];
  const svgs: string[] = [];
  let text = "";
  let usage: AgentResult["usage"];
  let costUsd: number | undefined;

  const stream = query({
    prompt: input(),
    options: {
      model: opts.model ?? MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { omnipro: omniproServer },
      allowedTools: ALLOWED_TOOLS,
      // The agent answers from the manual. It has no business touching the
      // filesystem, the shell, or the open internet.
      disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns ?? 14,
      includePartialMessages: Boolean(onEvent),
      env: { ...process.env, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" },
    },
  });

  // With includePartialMessages the full assistant message arrives AS WELL AS the
  // deltas, so track which text we already streamed to avoid emitting it twice.
  let streamed = "";

  for await (const msg of stream as AsyncIterable<SDKMessage>) {
    if (msg.type === "stream_event") {
      const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        streamed += ev.delta.text;
        emit({ type: "text", delta: ev.delta.text });
      }
      continue;
    }

    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") text += block.text;
        if (block.type === "tool_use") {
          toolCalls.push({ name: block.name, input: block.input });
          emit({ type: "tool", name: block.name, phase: "start" });
        }
      }
    }

    if (msg.type === "user" && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content as unknown as Array<Record<string, unknown>>) {
        if (block["type"] !== "tool_result") continue;
        const last = toolCalls[toolCalls.length - 1];
        if (!last) continue;
        if (block["is_error"] !== true) {
          emit({ type: "tool", name: last.name, phase: "ok" });
          for (const d of drainDiagrams()) {
            svgs.push(d.svg);
            emit({ type: "diagram", svg: d.svg, title: d.title, ...(d.subtitle ? { subtitle: d.subtitle } : {}) });
          }
          for (const w of drainWidgets()) emit({ type: "widget", payload: w });
          continue;
        }
        last.isError = true;
        // Keep the rejection reason: a spec the verifier refused is the most
        // informative event in the trace, and the eval suite grades on it.
        const body = block["content"];
        const asText = Array.isArray(body)
          ? (body as Array<{ type?: string; text?: string }>)
              .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
              .join("")
          : typeof body === "string"
            ? body
            : "";
        last.error = asText.slice(0, 600);
        emit({ type: "tool", name: last.name, phase: "rejected", detail: last.error });
      }
    }

    if (msg.type === "result") {
      if (msg.subtype === "success") text = msg.result || text;
      const u = msg.usage;
      if (u) {
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        };
      }
      costUsd = msg.total_cost_usd;
    }
  }

  // Anything not already drained mid-stream (the non-streaming path).
  for (const d of drainDiagrams()) {
    svgs.push(d.svg);
    emit({ type: "diagram", svg: d.svg, title: d.title, ...(d.subtitle ? { subtitle: d.subtitle } : {}) });
  }
  for (const w of drainWidgets()) emit({ type: "widget", payload: w });
  if (!text && streamed) text = streamed;

  // Audit the prose before anyone sees it. Costs about a millisecond and no API
  // call, so it runs on every answer rather than only in the eval suite.
  const numbers = checkAnswer(text, turn.text);
  emit({ type: "numbers", check: numbers });

  const final: AgentResult = {
    text,
    toolCalls,
    svgs,
    numbers,
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  emit({ type: "done", result: final });
  return final;
}
