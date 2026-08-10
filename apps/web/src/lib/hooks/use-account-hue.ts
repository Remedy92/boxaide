"use client";

import * as React from "react";
import {
  accountHueVar,
  assignAccountHues,
  hueVar,
} from "@/lib/format/hue";
import { useAccounts } from "@/lib/hooks/use-accounts";

/**
 * Returns `seed -> css colour`, resolved against the whole account set so two
 * mailboxes never share a rail hue. A seed that is not a known account id (a
 * sender address, or a row that rendered before the accounts query resolved)
 * falls back to the plain hash.
 */
export function useAccountHue(): (seed: string) => string {
  const accounts = useAccounts();
  const ids = accounts.data?.map((a) => a.id);
  // Joined so the memo compares by value; the query returns a new array each
  // fetch even when the account set has not changed.
  const key = ids?.join(",") ?? "";
  return React.useMemo(() => {
    const map = assignAccountHues(key ? key.split(",") : []);
    return (seed: string) => {
      const bucket = map.get(seed);
      return bucket === undefined ? accountHueVar(seed) : hueVar(bucket);
    };
  }, [key]);
}
