export function parseIssueTarget(raw: string): {
  repository: string;
  issueNumber: number;
} {
  const trimmed = raw.trim();
  const shorthand = /^([^/\s]+\/[^/\s#]+)#(\d+)$/.exec(trimmed);
  if (shorthand) {
    return {
      repository: shorthand[1]!,
      issueNumber: Number(shorthand[2]),
    };
  }

  const issueUrl =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/i.exec(trimmed);
  if (issueUrl) {
    return {
      repository: `${issueUrl[1]!}/${issueUrl[2]!}`,
      issueNumber: Number(issueUrl[3]),
    };
  }

  throw new Error(
    `Invalid target "${raw}". Expected owner/repo#123 or https://github.com/owner/repo/issues/123`,
  );
}
