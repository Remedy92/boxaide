"use client";

import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import { useAccounts } from "@/lib/hooks/use-accounts";
import type { AccountError } from "@/lib/types";

/**
 * §6.3 / §7.6. A partial account failure is a 200, not an error: mail from the
 * healthy mailboxes renders normally and this strip states which ones did not
 * answer.
 *
 * This is the honest, load-bearing status surface of the whole product. It must
 * never be suppressed or summarised away, and the raw driver text stays in
 * `title`, one per line, exactly as web/app.js does today.
 */
export function AccountErrorBanner({
  errors,
  total,
  onRetry,
}: {
  errors: AccountError[];
  /** accounts.length when the filter is "all", otherwise 1. */
  total: number;
  onRetry: () => void;
}) {
  const app = useApp();
  const accounts = useAccounts();
  const failing = errors.length > 0;
  const loaded = Math.max(total - errors.length, 0);
  const raw = errors.map((entry) => `${entry.account}: ${entry.error}`).join("\n");

  const onFix = (accountAlias: string) => {
    const acc = (accounts.data ?? []).find((a) => a.alias === accountAlias);
    if (acc) {
      app.requestEditAccount(acc);
    } else {
      app.openDialog("connect");
    }
  };

  // The live region is mounted whether or not it has content. A region created
  // in the same commit as its first content is not announced by most AT — and
  // this is the one surface that must not go unheard.
  return (
    <div
      role="status"
      aria-live="polite"
      title={failing ? raw : undefined}
      className={
        failing ? "bg-warning-bg px-3 py-2 text-[12px] leading-4 text-warning" : undefined
      }
    >
      {failing && (
        <>
          <span className="font-medium">
            {loaded} of {total} mailboxes loaded
          </span>
          <span> — </span>
          {errors.map((entry, index) => (
            <span key={`${entry.account}-${index}`}>
              {index > 0 && "; "}
              {entry.account}: {friendlyError(entry.error)}
            </span>
          ))}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="ml-2 h-4 px-0 text-warning"
            onClick={onRetry}
          >
            Retry
          </Button>
          {errors.map((entry) => (
            <Button
              key={`fix-${entry.account}`}
              type="button"
              variant="link"
              size="sm"
              className="ml-2 h-4 px-0 text-warning underline font-medium"
              onClick={() => onFix(entry.account)}
            >
              Fix {entry.account}
            </Button>
          ))}
        </>
      )}
    </div>
  );
}
