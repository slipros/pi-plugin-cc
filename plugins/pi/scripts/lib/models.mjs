import { runCommand } from "./process.mjs";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * `pi --list-models` prints a fixed-width table:
 *
 *   provider     model              context  max-out  thinking  images
 *   opencode-go  glm-5.2            1M       131.1K   yes       no
 */
export function parseModelTable(stdout) {
  const lines = String(stdout ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const models = [];
  for (const line of lines) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2) {
      continue;
    }
    const [provider, model, context, maxOut, thinking, images] = columns;
    if (provider === "provider" && model === "model") {
      continue;
    }
    models.push({
      provider,
      model,
      id: `${provider}/${model}`,
      context: context ?? null,
      maxOutput: maxOut ?? null,
      thinking: thinking === "yes",
      images: images === "yes"
    });
  }
  return models;
}

export function listModels(piBinary, { cwd, search = null } = {}) {
  const args = ["--list-models"];
  if (search) {
    args.push(search);
  }
  const result = runCommand(piBinary, args, { cwd });
  if (result.status !== 0) {
    throw new Error(
      `\`${piBinary} --list-models\` failed with exit code ${result.status}. ${result.stderr.trim()}`.trim()
    );
  }
  return parseModelTable(result.stdout);
}

export function groupByProvider(models) {
  const grouped = new Map();
  for (const entry of models) {
    if (!grouped.has(entry.provider)) {
      grouped.set(entry.provider, []);
    }
    grouped.get(entry.provider).push(entry);
  }
  return grouped;
}

export function normalizeThinking(value) {
  if (value == null || value === "") {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!THINKING_LEVELS.has(normalized)) {
    throw new Error(
      `Unsupported thinking level "${value}". Use one of: ${[...THINKING_LEVELS].join(", ")}.`
    );
  }
  return normalized;
}

/**
 * Validate a requested model against the catalogue.
 *
 * pi accepts patterns and fuzzy matches, so an unresolved name is not fatal —
 * it is reported as a warning and handed to pi unchanged.
 */
export function resolveModelSelection(models, { model = null, provider = null } = {}) {
  if (!model) {
    return { model: null, provider, matched: null, warning: null };
  }

  const requested = String(model).trim();
  const [thinkingSuffix] = requested.match(/:([a-z]+)$/i) ?? [];
  const bare = thinkingSuffix ? requested.slice(0, -thinkingSuffix.length) : requested;

  const candidates = provider ? models.filter((entry) => entry.provider === provider) : models;
  const exact =
    candidates.find((entry) => entry.id === bare) ?? candidates.find((entry) => entry.model === bare);
  if (exact) {
    return { model: requested, provider: provider ?? exact.provider, matched: exact, warning: null };
  }

  const lowered = bare.toLowerCase();
  const fuzzy = candidates.filter(
    (entry) => entry.id.toLowerCase().includes(lowered) || entry.model.toLowerCase().includes(lowered)
  );
  if (fuzzy.length === 1) {
    return {
      model: requested,
      provider: provider ?? fuzzy[0].provider,
      matched: fuzzy[0],
      warning: null
    };
  }

  return {
    model: requested,
    provider,
    matched: null,
    warning:
      fuzzy.length > 1
        ? `Model "${requested}" matches ${fuzzy.length} catalogue entries (${fuzzy
            .slice(0, 5)
            .map((entry) => entry.id)
            .join(", ")}). pi will resolve it with its own matching rules.`
        : `Model "${requested}" is not in the local pi catalogue. Run \`/pi:models\` to see what is available.`
  };
}

export { THINKING_LEVELS };
