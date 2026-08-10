"use client";

import { Paperclip } from "lucide-react";

/**
 * §6.4.5. `hasAttachments` is a bare boolean: there is no count, no filename,
 * no size and no download endpoint — mailparser's attachments are discarded in
 * mime.ts before they ever reach HTTP.
 *
 * So this is a glyph and one sentence. It is not a button, not a link, not a
 * chip, and it has no hover state. A clickable paperclip that does nothing is a
 * lie.
 */
export function AttachmentNote() {
  return (
    <p className="mt-3 flex items-center gap-1.5 text-[12px] leading-4 text-fg-tertiary">
      <Paperclip aria-hidden="true" className="size-3" strokeWidth={1.5} />
      Has attachments. This client can&rsquo;t download them.
    </p>
  );
}
