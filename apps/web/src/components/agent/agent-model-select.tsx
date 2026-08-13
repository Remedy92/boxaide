"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocalAgents } from "@/lib/hooks/use-local-agents";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";

/**
 * The model picker inside the composer, in the spot shadcn's AI prompt-input
 * puts it: bottom-left of the input box, styled as a quiet control.
 *
 * The choice is a launch parameter, not a per-message one — a running CLI
 * cannot switch models mid-session. So the pick is stored in settings and
 * read by the sidebar Start button; picking while an agent runs applies on
 * the next start. Renders nothing when no installed agent offers models.
 */
export function AgentModelSelect() {
  const agents = useLocalAgents();
  const settings = useSettings();
  const update = useUpdateSettings();

  const withModels = (agents.data?.agents ?? []).find(
    (a) => a.available && a.supported && a.models.length > 0,
  );
  if (!withModels) return null;

  const known = withModels.models.some((m) => m.id === settings.agentModel);

  return (
    <Select
      // A stored id the server no longer offers falls back to Default in the
      // UI, and Start simply omits it.
      value={known ? settings.agentModel : ""}
      onValueChange={(value) => update({ agentModel: value === "default" ? "" : value })}
    >
      <SelectTrigger
        size="sm"
        aria-label="Model for your agent"
        className="h-6 gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-tertiary hover:text-fg-secondary [&_svg:not([class*='size-'])]:size-3"
      >
        <SelectValue placeholder="Default model" />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="default">Default model</SelectItem>
        {withModels.models.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
