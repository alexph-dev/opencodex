import type { AdapterEvent } from "../types";

/**
 * Recovers reasoning from upstreams that have no server-side reasoning parser and leave
 * thinking inline in chat `content` as <think>...</think> blocks (Gonka-served MiniMax/GLM)
 * instead of sending it as `reasoning_content` / `reasoning_details`.
 *
 * Self-gating: the splitter engages only when a response OPENS with a thinking tag, which is
 * what an unparsed thinking model always does. A response whose first characters are ordinary
 * text passes through untouched for the rest of that response, so a model that merely mentions
 * a think tag inside an answer is never rewritten.
 *
 * MiniMax M-series interleaves several think blocks with answer segments, so once engaged the
 * splitter keeps splitting for the whole response rather than only the leading block.
 */
type ThinkingTag = "<thinking>" | "<think>" | "<reasoning>";

const OPEN_TAGS: ThinkingTag[] = ["<thinking>", "<think>", "<reasoning>"];

function closeTagFor(openTag: string): string {
  return `</${openTag.slice(1)}`;
}

const MAX_OPEN_TAG = Math.max(...OPEN_TAGS.map(tag => tag.length));
const MAX_CLOSE_TAG = Math.max(...OPEN_TAGS.map(tag => closeTagFor(tag).length));

function isPossibleOpenTagPrefix(text: string): boolean {
  return OPEN_TAGS.some(tag => tag.startsWith(text) && text.length < tag.length);
}

export class InlineThinkTagSplitter {
  private decided = false;
  private engaged = false;
  private mode: "text" | "thinking" = "text";
  private carry = "";
  private closeTag = "";

  feed(text: string): AdapterEvent[] {
    if (!text) return [];
    if (this.decided && !this.engaged) return [{ type: "text_delta", text }];
    this.carry += text;
    return this.drain();
  }

  /** Emit whatever is still carried when the response ends. */
  flush(): AdapterEvent[] {
    const events: AdapterEvent[] = [];
    const thinking = this.mode === "thinking";
    this.decided = true;
    if (this.carry) {
      events.push(thinking
        ? { type: "reasoning_raw_delta", text: this.carry }
        : { type: "text_delta", text: this.carry });
      this.carry = "";
    }
    this.mode = "text";
    return events;
  }

  /** Drop any partial-tag carry when the owning stream stops early. */
  dispose(): void {
    this.carry = "";
    this.mode = "text";
  }

  private safeCut(cut: number): number {
    if (cut <= 0) return 0;
    if (cut < this.carry.length) {
      const atCut = this.carry.charCodeAt(cut - 1);
      // Never split a surrogate pair at a send boundary.
      if (atCut >= 0xd800 && atCut <= 0xdbff) return cut - 1;
    }
    return cut;
  }

  private drain(): AdapterEvent[] {
    const events: AdapterEvent[] = [];
    for (;;) {
      if (this.mode === "thinking") {
        const closeIndex = this.carry.indexOf(this.closeTag);
        if (closeIndex >= 0) {
          const thinking = this.carry.slice(0, closeIndex);
          if (thinking) events.push({ type: "reasoning_raw_delta", text: thinking });
          this.carry = this.carry.slice(closeIndex + this.closeTag.length).trimStart();
          this.mode = "text";
          continue;
        }
        const cut = this.safeCut(this.carry.length - Math.min(this.carry.length, MAX_CLOSE_TAG));
        if (cut > 0) {
          events.push({ type: "reasoning_raw_delta", text: this.carry.slice(0, cut) });
          this.carry = this.carry.slice(cut);
        }
        return events;
      }

      if (!this.decided) {
        const stripped = this.carry.trimStart();
        const openTag = OPEN_TAGS.find(tag => stripped.startsWith(tag));
        if (openTag) {
          this.decided = true;
          this.engaged = true;
          this.mode = "thinking";
          this.closeTag = closeTagFor(openTag);
          this.carry = stripped.slice(openTag.length);
          continue;
        }
        if (stripped.length < MAX_OPEN_TAG && isPossibleOpenTagPrefix(stripped)) return events;
        this.decided = true;
        this.engaged = false;
        if (this.carry) {
          events.push({ type: "text_delta", text: this.carry });
          this.carry = "";
        }
        return events;
      }

      let openIndex = -1;
      let openTag = "";
      for (const tag of OPEN_TAGS) {
        const index = this.carry.indexOf(tag);
        if (index >= 0 && (openIndex < 0 || index < openIndex)) {
          openIndex = index;
          openTag = tag;
        }
      }
      if (openIndex >= 0) {
        const before = this.carry.slice(0, openIndex);
        if (before) events.push({ type: "text_delta", text: before });
        this.carry = this.carry.slice(openIndex + openTag.length);
        this.mode = "thinking";
        this.closeTag = closeTagFor(openTag);
        continue;
      }
      const cut = this.safeCut(this.carry.length - Math.min(this.carry.length, MAX_OPEN_TAG - 1));
      if (cut > 0) {
        events.push({ type: "text_delta", text: this.carry.slice(0, cut) });
        this.carry = this.carry.slice(cut);
      }
      return events;
    }
  }
}
