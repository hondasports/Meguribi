import * as v from "valibot";

function isValidExecutableBase(value: string): boolean {
  if (value.trim() !== value) return false;
  if (value.startsWith("-")) return false;
  if (value.includes("://")) return false;
  if (value.includes("=")) return false;
  if (value.includes('"')) return false;
  if (/[&|;<>$`\p{Control}]/u.test(value)) return false;
  return true;
}

// Single executable path/name only, without spaces. This rejects command
// templates and secret flags for the simple string form.
export function isValidExecutableString(value: string): boolean {
  if (!isValidExecutableBase(value)) return false;
  if (/\s/u.test(value)) return false;
  return true;
}

// Used for the one-element tuple form, which is the only way to represent an
// executable path that contains spaces. The whole element is the executable
// path; additional tuple elements (command arguments) are rejected by the
// strictTuple schema shape itself. We only guard against structural injection
// patterns (=, URL scheme, leading -) so that relative spaced paths such as
// [Cursor Agent.exe] and [tools\\Cursor Agent.exe] are accepted.
export function isValidExecutablePath(value: string): boolean {
  return isValidExecutableBase(value);
}

export const executableSchema = v.optional(
  v.union([
    v.pipe(
      v.string(),
      v.nonEmpty(),
      v.check(isValidExecutableString, "Invalid executable"),
    ),
    v.strictTuple([
      v.pipe(
        v.string(),
        v.nonEmpty(),
        v.check(isValidExecutablePath, "Invalid executable"),
      ),
    ]),
  ]),
);
