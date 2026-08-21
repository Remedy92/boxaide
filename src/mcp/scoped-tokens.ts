/**
 * The credentials Boxaide hands to the agents it launches.
 *
 * One master bearer used to be the only credential in the product, so every
 * launched CLI got the whole API: mail, settings, the platform, and the token
 * itself back out of /api/agent-connect. This mints a second kind — bound to
 * a scope (see scope.ts), accepted on /mcp and nowhere else, and revoked the
 * moment the launch it belongs to ends.
 *
 * In memory on purpose. A token that outlived the process would be a
 * credential nobody can see and nobody revokes; a restart should invalidate
 * every agent credential, because a restart already killed every agent.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ScopeProfile } from "./scope.js";

/** A minted credential and the only way to take it back. */
export type ScopedGrant = {
  token: string;
  profile: ScopeProfile;
  /** Idempotent: a launch may end more than one way. */
  revoke: () => void;
};

export type GrantInfo = {
  profile: ScopeProfile;
  /** Which launch this belongs to, for the status endpoint and for logs. */
  label: string;
  issuedAt: string;
};

/**
 * Keyed by digest, never by the token itself.
 *
 * A Map keyed by the raw secret answers in a length- and content-dependent
 * time, and the keys sit in a heap dump as usable credentials. Hashing costs
 * one sha256 per request and removes both.
 */
function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class ScopedTokens {
  private grants = new Map<string, GrantInfo>();

  /**
   * A fresh credential for one launch.
   *
   * 32 bytes from the CSPRNG: this is a bearer token on a loopback port that
   * every local process can reach, so it has to be unguessable rather than
   * merely unique.
   */
  mint(profile: ScopeProfile, label: string): ScopedGrant {
    const token = randomBytes(32).toString("base64url");
    const key = digest(token);
    this.grants.set(key, {
      profile,
      label,
      issuedAt: new Date().toISOString(),
    });
    let revoked = false;
    return {
      token,
      profile,
      revoke: () => {
        if (revoked) return;
        revoked = true;
        this.grants.delete(key);
      },
    };
  }

  /**
   * The profile this token carries, or null if it is not one of ours.
   *
   * Null is not "unrestricted" — the caller must have already ruled out the
   * master bearer. Returning a profile here is the whole authorization
   * decision for an agent credential.
   */
  resolve(token: string): ScopeProfile | null {
    if (!token) return null;
    return this.grants.get(digest(token))?.profile ?? null;
  }

  /** Live grants, newest last. For the status endpoint; carries no secrets. */
  list(): GrantInfo[] {
    return [...this.grants.values()];
  }

  /** Shutdown: every agent credential dies with the process that issued it. */
  revokeAll(): void {
    this.grants.clear();
  }
}

/**
 * Constant-time compare for the master bearer.
 *
 * Re-exported shape of the API's own check so the /mcp path cannot drift into
 * an `===` while the API stays timing-safe.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Empty is never a match, even against an empty expectation. A bearer.token
  // that is empty — truncated write, restored backup, a touched file — would
  // otherwise make "no Authorization header at all" the master credential, and
  // /mcp the one route on the app that answers an anonymous caller.
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
