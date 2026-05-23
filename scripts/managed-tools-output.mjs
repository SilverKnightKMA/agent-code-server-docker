export function actionForState(comparePolicy, state) {
  return comparePolicy?.[state] ?? state ?? "unknown";
}

function valueForField(value) {
  if (value === null || value === undefined || value === "") return "missing";
  const text = String(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

export function formatFields(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${valueForField(value)}`)
    .join(" ");
}

export function statusFields(row) {
  return {
    family: row.family,
    tool: row.tool,
    desired: row.desired,
    actual: row.actual ?? "missing",
    path: row.path,
    state: row.state,
    action: row.action,
    diagnostic: row.diagnostic,
    source: row.source,
  };
}

function comparePrefix(state) {
  if (state === "missing") return "[install]";
  if (state === "equal") return "[skip]";
  if (state === "lower") return "[upgrade]";
  return "[warn]";
}

function warningFields(row) {
  const diagnostic = row.state === "higher" ? "newer-than-pinned-skip-downgrade" : row.diagnostic;
  return { ...statusFields(row), diagnostic };
}

export function printStatusRow(row) {
  console.log(`status ${formatFields(statusFields(row))}`);
  if (row.state === "higher" || row.state === "unparseable") {
    console.warn(`[warn] ${formatFields(warningFields(row))}`);
  }
}

export function printCompareRow(row) {
  const line = `${comparePrefix(row.state)} ${formatFields(statusFields(row))}`;
  if (row.state === "higher" || row.state === "unparseable") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function diagnosticForState(state, installedLabel = "tool") {
  if (state === "missing") return `${installedLabel}-missing`;
  if (state === "equal") return "matches-pinned-version";
  if (state === "lower") return "older-than-pinned-upgrade";
  if (state === "higher") return "newer-than-pinned-skip-downgrade";
  if (state === "unparseable") return "version-unparseable-skip";
  return "unknown-state";
}
