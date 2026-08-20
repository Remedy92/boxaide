import * as React from "react";

/**
 * The two pieces of motion this page adds beyond hover states.
 *
 * Both hang off the same scroll container. The page does not scroll the window:
 * globals.css sets `overflow: hidden` on the body because every pane in the app
 * scrolls itself, and the install page kept that shape. So the observer needs
 * that element as its root, and the parallax reads that element's scrollTop.
 * Neither works against `window`.
 */

/**
 * Reveal each marked part as it arrives.
 *
 * The hidden state is in CSS under `[data-armed]`, which is rendered by the
 * server, so nothing flashes into view and then hides itself while React
 * hydrates. A `<noscript>` sheet on the page cancels it for a browser that
 * never runs this hook.
 *
 * `data-reveal` carries the part's place in its group, and the delay it turns
 * into is what makes a section arrive as a sequence rather than a slab.
 */
export function useRevealOnScroll(
  scrollRef: React.RefObject<HTMLElement | null>,
) {
  React.useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    const parts = Array.from(
      root.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    if (parts.length === 0) return;

    const show = (el: Element) => el.classList.add("mailmux-shown");

    for (const part of parts) {
      const step = Number(part.dataset.reveal) || 0;
      part.style.setProperty("--reveal-delay", `${step * 70}ms`);
    }

    if (!("IntersectionObserver" in window)) {
      parts.forEach(show);
      return;
    }

    let spoke = false;
    const observer = new IntersectionObserver(
      (entries) => {
        spoke = true;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          show(entry.target);
          observer.unobserve(entry.target);
        }
      },
      // The bottom inset holds a part back until it is properly on screen
      // rather than one pixel over the edge.
      { root, rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    for (const part of parts) observer.observe(part);

    // A background tab suspends the observer, and a window taller than the page
    // never scrolls. Nothing here is allowed to stay invisible for either
    // reason, so an observer that has not spoken at all loses its turn.
    const rescue = window.setTimeout(() => {
      if (!spoke) parts.forEach(show);
    }, 1_200);

    return () => {
      observer.disconnect();
      window.clearTimeout(rescue);
    };
  }, [scrollRef]);
}

/**
 * The background moves slower than the page, and the header grows a rule once
 * the page has left the top.
 *
 * One listener, one rAF, two custom properties. `--mailmux-parallax` is read by
 * the atmosphere's transform and `data-scrolled` by the header — both are
 * compositor-only work, so this never causes layout.
 */
export function useScrollAtmosphere(
  scrollRef: React.RefObject<HTMLElement | null>,
) {
  React.useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const paint = () => {
      frame = 0;
      const y = root.scrollTop;
      root.style.setProperty("--mailmux-parallax", `${y * 0.28}px`);
      root.dataset.scrolled = y > 24 ? "true" : "false";
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(paint);
    };

    paint();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [scrollRef]);
}
