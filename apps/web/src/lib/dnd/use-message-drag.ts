"use client";

import * as React from "react";
import {
  currentMessageDrag,
  subscribeMessageDrag,
  type MessageDrag,
} from "@/lib/dnd/message-drag";

/**
 * The one React binding onto the drag singleton, kept in its own file so
 * message-drag.ts stays free of React.
 *
 * That separation is load-bearing, not tidiness: the drop rules are covered by
 * a test under the ROOT vitest project, which resolves from the repo's own
 * node_modules and has no react in it. A single `import * as React` in the
 * module holding those rules is enough to fail that suite with
 * ERR_MODULE_NOT_FOUND, and it fails only in CI, because a local checkout has
 * apps/web/node_modules sitting right there to resolve from.
 */
export function useMessageDrag(): MessageDrag | null {
  return React.useSyncExternalStore(
    subscribeMessageDrag,
    currentMessageDrag,
    /* Null on the server, so the prerendered HTML and the first client render
       agree: nothing is being dragged before the page is interactive. */
    () => null,
  );
}
