"use client";

import * as React from "react";
import { ArrowUp } from "lucide-react";
import { Spinner } from "@/components/atoms";
import { AgentModelSelect } from "@/components/agent/agent-model-select";
import { AgentSelect } from "@/components/agent/agent-select";
import { cn } from "@/lib/utils";

/** Matches MAX_CHAT_CHARS on the server, which returns 400 past it. */
const MAX_CHARS = 8_000;

/** Grows to about eight lines, then scrolls. */
const MAX_HEIGHT = 168;

/**
 * The composer.
 *
 * Enter sends and Shift+Enter breaks the line. That is the right way round for
 * a conversation — the newline is the rarer intent — and it is the convention
 * every agent client already uses, so muscle memory carries over.
 *
 * Sending is never blocked on an agent being present. A message posted with
 * nobody listening is queued on the server and handed over the moment one
 * starts, so refusing to send would break the perfectly normal "type the
 * question, then start your agent" order.
 */
export function AgentComposer({
  onSend,
  sending,
  disabled,
  autoFocus,
}: {
  onSend: (text: string) => void;
  sending: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = React.useState("");
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  const resize = React.useCallback(() => {
    const node = ref.current;
    if (!node) return;
    // Collapse before measuring, or the box only ever grows.
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  // Layout effect, so the first measured height is the one that gets painted
  // rather than a frame of the wrong size.
  React.useLayoutEffect(resize, [resize, text]);

  /**
   * Measure again once the webfont has landed.
   *
   * A height measured against the fallback face can be wrong, and nothing else
   * would ever correct it: the only other trigger is a change to `text`, so an
   * empty composer that mis-measured on mount stays mis-measured until the user
   * types. That was observed once as a full-height empty box on a cold load.
   */
  React.useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) resize();
    });
    return () => {
      live = false;
    };
  }, [resize]);

  const submit = () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    onSend(value);
    setText("");
    // The height has to be reset by hand: the effect above runs after paint and
    // would leave a tall empty box for one frame.
    requestAnimationFrame(resize);
  };

  const overLimit = text.length > MAX_CHARS;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        "rounded-[var(--radius-lg)] border bg-surface-2 transition-colors duration-[var(--dur-fast)]",
        "focus-within:border-accent",
        overLimit ? "border-danger" : "border-border-control",
      )}
    >
      <label htmlFor="mailmux-agent-input" className="sr-only">
        Message your agent
      </label>
      <textarea
        id="mailmux-agent-input"
        ref={ref}
        rows={1}
        value={text}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          // A composition Enter is the IME committing a candidate, not a send.
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          submit();
        }}
        placeholder="Ask about your mail…"
        aria-describedby="mailmux-agent-hint"
        className={cn(
          "pane-scroll block w-full resize-none bg-transparent px-3 pt-2.5 pb-1",
          "text-[13px] leading-[20px] text-fg placeholder:text-fg-tertiary",
          "outline-none disabled:cursor-not-allowed disabled:text-fg-disabled",
        )}
        style={{ maxHeight: MAX_HEIGHT }}
      />

      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <AgentSelect disabled={disabled || sending} />
          <AgentModelSelect disabled={disabled || sending} />
          <p
            id="mailmux-agent-hint"
            className="truncate pl-1 text-[11px] leading-4 text-fg-tertiary"
          >
            {overLimit ? (
              <span className="text-danger">
                {text.length.toLocaleString()} of {MAX_CHARS.toLocaleString()} characters
              </span>
            ) : (
              <>
                <kbd className="font-sans">Enter</kbd> to send,{" "}
                <kbd className="font-sans">Shift</kbd>+
                <kbd className="font-sans">Enter</kbd> for a new line
              </>
            )}
          </p>
        </div>
        <button
          type="submit"
          aria-label="Send to your agent"
          disabled={!text.trim() || sending || disabled || overLimit}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
            "bg-accent-fill text-accent-fill-fg transition-colors duration-[var(--dur-fast)]",
            "hover:bg-[var(--accent-fill-hover)]",
            "disabled:bg-surface-hover disabled:text-fg-disabled",
          )}
        >
          {sending ? <Spinner /> : <ArrowUp className="size-4" strokeWidth={1.5} />}
        </button>
      </div>
    </form>
  );
}
