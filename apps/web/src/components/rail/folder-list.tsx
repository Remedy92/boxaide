"use client";

import {
  Archive,
  FilePen,
  Folder,
  Send,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { NavItem } from "@/components/rail/nav-item";
import { SectionLabel } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { useFolders } from "@/lib/hooks/use-folders";
import type { MailFolder } from "@/lib/types";

/**
 * §6.2 row 5. Rendered from GET /api/folders?account=<id>.
 *
 * These icons label a folder the server listed; they are not actions. There is
 * no move, no copy and no expunge on MailProvider, so folders are read-only
 * navigation. There is never an unread badge — MailFolder is
 * {name, path, specialUse?} and carries no count at all.
 */
const SPECIAL_ICON: Record<string, LucideIcon> = {
  "\\sent": Send,
  "\\drafts": FilePen,
  "\\trash": Trash2,
  "\\junk": ShieldAlert,
  "\\archive": Archive,
};

function iconFor(folder: MailFolder): LucideIcon {
  const key = folder.specialUse?.toLowerCase();
  return (key && SPECIAL_ICON[key]) || Folder;
}

export function FolderList({
  accountRef,
  activeFolder,
  onSelect,
  collapsed = false,
  disabled = false,
}: {
  accountRef: string;
  activeFolder: string | undefined;
  onSelect: (path: string | undefined) => void;
  collapsed?: boolean;
  /** True while another view owns the list pane: no folder is current then. */
  disabled?: boolean;
}) {
  const isAll = accountRef === "all";
  const folders = useFolders(accountRef);

  if (collapsed) return null;

  return (
    <div className="space-y-0.5">
      <SectionLabel>Folders</SectionLabel>

      {isAll ? (
        <p className="px-2 py-1 text-[12px] leading-4 text-fg-tertiary">
          Pick one mailbox to browse its folders.
        </p>
      ) : folders.isPending ? (
        <p className="px-2 py-1 text-[12px] leading-4 text-fg-tertiary">
          Loading folders…
        </p>
      ) : folders.isError ? (
        <div role="status" className="px-2 py-1">
          <p className="text-[12px] leading-4 text-danger">
            Could not list folders.
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-6 px-0"
            onClick={() => void folders.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        (folders.data ?? []).map((folder) => (
          <NavItem
            key={folder.path}
            icon={iconFor(folder)}
            label={folder.name}
            title={folder.path}
            ariaLabel={`Folder ${folder.path}`}
            active={!disabled && activeFolder === folder.path}
            onClick={() =>
              onSelect(
                !disabled && activeFolder === folder.path
                  ? undefined
                  : folder.path,
              )
            }
          />
        ))
      )}
    </div>
  );
}
