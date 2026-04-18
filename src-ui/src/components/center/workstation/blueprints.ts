// Seed blueprints for Phase 2 — YAML files bundled via Vite `?raw`.
//
// Per product philosophy: a blueprint ships ONLY names + structure.
// No models, no skills, no prompts. The user configures all of that
// inside each activated container.
//
// Moving the templates out of TS into YAML means:
//   - Non-coders can submit blueprints via PR
//   - The format is what Phase 5's marketplace will import at runtime
//   - Our TS code never grows as the template catalog grows

import { parse as parseYaml } from 'yaml';
import type { Blueprint } from './types';

import gameStudioYaml from './defaults/game-studio.yml?raw';
import startupTeamYaml from './defaults/startup-team.yml?raw';
import writingTeamYaml from './defaults/writing-team.yml?raw';

/**
 * Minimal runtime check that a parsed YAML conforms to the Blueprint
 * shape. Throws with a readable message when a required field is missing
 * so the error surfaces at build time / first load — not at render time
 * with a cryptic TypeError deep in react-flow.
 */
function parseBlueprint(raw: string, sourceHint: string): Blueprint {
  const parsed = parseYaml(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`blueprint "${sourceHint}" did not parse to an object`);
  }
  const bp = parsed as Partial<Blueprint>;
  const missing = (['id', 'name', 'icon', 'description', 'author', 'nodes', 'edges'] as const)
    .filter(k => bp[k] === undefined);
  if (missing.length) {
    throw new Error(
      `blueprint "${sourceHint}" is missing required field(s): ${missing.join(', ')}`,
    );
  }
  if (!Array.isArray(bp.nodes) || !Array.isArray(bp.edges)) {
    throw new Error(`blueprint "${sourceHint}" must have nodes[] and edges[]`);
  }
  return bp as Blueprint;
}

export const BLUEPRINTS: Blueprint[] = [
  parseBlueprint(gameStudioYaml, 'game-studio'),
  parseBlueprint(startupTeamYaml, 'startup-team'),
  parseBlueprint(writingTeamYaml, 'writing-team'),
];

/**
 * Pick a blueprint by id. Used when the user clicks a template card.
 * Returns null instead of throwing so callers can fall back gracefully.
 */
export function findBlueprint(id: string): Blueprint | null {
  return BLUEPRINTS.find(b => b.id === id) ?? null;
}
