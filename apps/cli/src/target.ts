export function parseIssueTarget(raw: string): {
  repository: string;
  issueNumber: number;
} {
  const trimmed = raw.trim();
  const shorthand = /^([^/\s]+\/[^/\s#]+)#(\d+)$/.exec(trimmed);
  if (shorthand) {
    const repository = shorthand[1]!;
    assertSafeRepository(repository);
    return {
      repository,
      issueNumber: Number(shorthand[2]),
    };
  }

  const issueUrl =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/i.exec(trimmed);
  if (issueUrl) {
    const repository = `${issueUrl[1]!}/${issueUrl[2]!}`;
    assertSafeRepository(repository);
    return {
      repository,
      issueNumber: Number(issueUrl[3]),
    };
  }

  throw new Error(
    `Invalid target "${raw}". Expected owner/repo#123 or https://github.com/owner/repo/issues/123`,
  );
}

function assertSafeRepository(repository: string): void {
  const [owner, repo, ...rest] = repository.split("/");
  if (rest.length > 0 || !owner || !repo) {
    throw new Error(`Invalid repository identity: ${repository}`);
  }
  for (const [label, value] of [
    ["owner", owner],
    ["repo", repo],
  ] as const) {
    if (value === "." || value === ".." || value.includes("\\") || value.includes("\0")) {
      throw new Error(`Invalid repository ${label} segment: ${value}`);
    }
  }
}
