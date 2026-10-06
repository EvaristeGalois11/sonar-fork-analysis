# Security policy

This action analyses pull requests from forks with a Sonar token, so its whole
purpose is to keep that token away from code the fork controls. Reports of
anything that weakens that are very welcome.

## Supported versions

| Version | Supported                                       |
| ------- | ----------------------------------------------- |
| v2      | Yes                                             |
| v1      | No: it has known weaknesses, and v2 replaces it |

## Reporting a vulnerability

Please report it privately, through
[GitHub's vulnerability reporting](https://github.com/galois-groups/sonar-fork-analysis/security/advisories/new),
not in a public issue or pull request.

Include what an attacker controls (e.g. a fork's branch name, its build, its
artifact), what they gain, and the steps or a workflow that reproduce it. This
is a personal project, so replies are best effort, but security reports come
first.

## Out of scope

- Workflows that run fork code with secrets despite the documentation, e.g. a
  build on `pull_request_target`.
- Self-hosted runners shared by fork builds and the analysis: GitHub advises
  against them for public repositories, since fork code can persistently
  compromise the machine
  ([Hardening for self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)).
