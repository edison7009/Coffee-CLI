// Shared SKILL.md frontmatter helpers. Both the Skills page (cards) and
// Gambit (popover items) need to render localised name + description, so
// the parsing + locale-fallback live in one place.

/** Parse YAML-frontmatter at the top of SKILL.md. Returns every key
 *  verbatim — the caller decides which subset matters. We do not pull in
 *  a YAML library: skill frontmatter is a tiny flat scalar map by
 *  convention (name, description, optional `<key>_<lang>` overrides). */
export function parseFrontmatter(md: string | null): Record<string, string> {
  if (!md) return {};
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const eq = line.indexOf(':');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes — frontmatter values may be
    // quoted ("name") or bare (name); both are valid YAML scalars.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Pick a localised frontmatter value with a 3-step fallback chain:
 *
 *   <key>_<full-lang>      e.g. description_zh-CN
 *   <key>_<lang-prefix>    e.g. description_zh   (when full doesn't exist)
 *   <key>                  e.g. description      (final fallback / English)
 *
 * Each skill self-declares which languages it supports — Coffee CLI's
 * own i18n system stays out of it. A skill that only writes English
 * `description` works perfectly in zh-CN UI (just shows the English
 * description). A skill that adds `description_zh-CN` upgrades the
 * zh-CN experience without affecting any other locale.
 */
export function localizedField(
  fm: Record<string, string>,
  key: string,
  lang: string,
): string {
  if (fm[`${key}_${lang}`]) return fm[`${key}_${lang}`];
  const prefix = lang.split('-')[0];
  if (prefix !== lang && fm[`${key}_${prefix}`]) return fm[`${key}_${prefix}`];
  return fm[key] || '';
}
