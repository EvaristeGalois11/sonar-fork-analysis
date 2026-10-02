# Sonar Fork Analysis

[![CI](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/ci.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/ci.yml)
[![Fixtures](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/fixtures.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/fixtures.yml)
[![Scanner](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/scanner.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/scanner.yml)
[![CodeQL](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/codeql.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/EvaristeGalois11/sonar-fork-analysis/badge)](https://scorecard.dev/viewer/?uri=github.com/EvaristeGalois11/sonar-fork-analysis)
![Coverage](./badges/coverage.svg)

Sonar analysis, with coverage and test results, for pull requests from forks,
which GitHub runs without your secrets.

The action builds the pull request where there are no secrets, then analyses the
result in a separate job that has the Sonar token but never runs the pull
request's code. That is the split SonarSource itself recommends for forks; this
action packages it for Maven and Gradle, carrying over everything the analysis
needs from the build: binaries, libraries, coverage and test reports, and the
settings the build defines.

If you don't need coverage on fork pull requests, SonarQube Cloud's
[Automatic Analysis](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/automatic-analysis/)
covers forks with no setup at all, within its limits: no coverage, no monorepos,
and less depth for some languages.

## Documentation

- [Security](docs/security.md): what the analysis trusts, what a fork can still
  influence, and how to harden your setup.
- [Troubleshooting](docs/troubleshooting.md): every message the action prints,
  and what to do about it.

## How it works

```
 pull request from a fork                     push, or pull request from this repository
 ─────────────────────────                    ──────────────────────────────────────────
 Build workflow, no Sonar token               Build workflow, with the Sonar token
   action, prepare mode:                        action, direct mode:
   builds, uploads settings and build output    builds and analyses, as Sonar's own plugins do
          │
          │ workflow_run
          ▼
 Sonar workflow, with the Sonar token
   action, analyze mode:
   checks the upload, checks out the pull request,
   analyses it without running any of its code
```

In the default mode, `auto`, the action picks its part by itself: it analyses
directly when it has a token, prepares an upload when it doesn't, and analyses
that upload when the Sonar workflow runs. The Sonar workflow starts after every
build, and does nothing when the build analysed directly.

## Setup

1. Create a Sonar token and store it as the repository secret `SONAR_TOKEN`. On
   SonarQube Cloud's free plan only personal tokens exist: use a dedicated one,
   named after this repository, with an expiry date. Paid plans can use a
   [scoped organization token](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-organization/scoped-organization-tokens)
   limited to _Execute analysis_ on the project; one without an expiry date
   lapses after 60 days without use.
2. Gradle builds apply the `org.sonarqube` plugin. Maven builds need nothing.
3. Add the action to your build workflow:

   ```yaml
   name: Build
   on:
     push:
       branches: [main]
     pull_request:
   permissions:
     contents: read
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
           with:
             persist-credentials: false
             fetch-depth: 0
         - uses: actions/setup-java@v6
           with:
             distribution: temurin
             java-version: 21
         - uses: evaristegalois11/sonar-fork-analysis@v2
           with:
             project-key: my-org_my-project
             sonar-organization: my-org
             sonar-token: ${{ secrets.SONAR_TOKEN }}
   ```

   The action runs the build itself (`verify` for Maven, `check` for Gradle; see
   `build-goals`), so it replaces your build step. The trigger must be
   `pull_request`, never `pull_request_target`: that is what keeps your secrets
   away from a fork's code, and the action refuses to build otherwise.

4. Add a Sonar workflow, triggered by the build:

   ```yaml
   name: Sonar
   on:
     workflow_run:
       workflows: [Build]
       types: [completed]
   jobs:
     sonar:
       if: github.event.workflow_run.conclusion == 'success'
       runs-on: ubuntu-latest
       permissions:
         actions: read
         contents: read
         pull-requests: read
         statuses: write
       steps:
         - uses: evaristegalois11/sonar-fork-analysis@v2
           with:
             project-key: my-org_my-project
             sonar-organization: my-org
             sonar-token: ${{ secrets.SONAR_TOKEN }}
   ```

   `project-key` must be the same in both workflows: it also names the upload.
   `statuses: write` is optional, see
   [commit statuses](#commit-statuses-and-required-checks).

Pin the action to a commit SHA rather than a tag if you pin your other actions.
See [security](docs/security.md#hardening-your-setup) for more hardening.

### Which commit the build tests

On a pull request, `actions/checkout` checks out GitHub's merge of the pull
request into your base branch, while the Sonar workflow analyses the pull
request's own head. Analysis results then combine the head's sources with the
merge's build: binaries and coverage come from slightly different code when the
base branch has moved on. For results that match the pull request exactly, check
out the head in the build:

```yaml
- uses: actions/checkout@v7
  with:
    persist-credentials: false
    fetch-depth: 0
    ref: ${{ github.event.pull_request.head.sha }}
```

That also changes what your whole build tests on pull requests, so it is your
call.

## Inputs

| Input                | Default            | Description                                                                                                                                                                |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-key`        |                    | The Sonar project key. Required, and the same in the build and the Sonar workflow.                                                                                         |
| `sonar-organization` |                    | The Sonar organization, required by SonarQube Cloud.                                                                                                                       |
| `sonar-token`        |                    | The Sonar token. Empty on pull requests from forks, which is what selects the fork path.                                                                                   |
| `sonar-host-url`     |                    | The Sonar server. Empty for SonarQube Cloud, or to use `SONAR_HOST_URL` or the build's own `sonar.host.url`.                                                               |
| `mode`               | `auto`             | `auto`, or `direct`, `prepare`, `analyze` to force one part.                                                                                                               |
| `working-directory`  | `.`                | The directory holding the Maven or Gradle build.                                                                                                                           |
| `build-tool`         | `auto`             | `auto`, `maven` or `gradle`.                                                                                                                                               |
| `build-goals`        | `verify` / `check` | Maven goals or Gradle tasks to run, one per line.                                                                                                                          |
| `build-arguments`    |                    | Extra build flags, one per line. In the Sonar workflow they go to the scanner instead, e.g. `-Dsonar.projectName=App`; relative paths there don't point into the checkout. |
| `checkout`           | `true`             | Sonar workflow: check out the analysed commit. `false` to check out yourself, see [own checkout](#your-own-checkout).                                                      |
| `github-token`       | `github.token`     | Downloads the upload and finds the pull request.                                                                                                                           |

## Commit statuses and required checks

With `statuses: write`, the Sonar workflow reports on the analysed commit, where
the pull request shows it: _Sonar fork analysis (your project key)_, pending
while it runs, then success or failure, with a link to the run. Without the
permission it posts nothing.

The Sonar workflow starts after the build finishes, so results arrive a little
later than the build's own checks. _The build left nothing to analyse_ means the
build didn't run the action for that project key.

To make the analysis block merging, require in your branch rules:

- _Sonar fork analysis (your project key)_, with GitHub Actions as its source;
- the Sonar check of the project, e.g. _SonarCloud Code Analysis_, with the
  Sonar app as its source.

Sonar's checks from a direct analysis never appear on pull requests from forks:
require the ones the Sonar workflow produces.

## Recipes

### Several projects

Run the action once per project key in both workflows, e.g. with a matrix over
`working-directory` and `project-key`. One Sonar workflow can analyse all of
them.

### Skipping runs with nothing to do

The Sonar workflow runs after every build. When the build analysed directly, it
ends quietly; to skip it entirely, run the job only for forks and Dependabot,
whose pull requests also go without secrets:

```yaml
if: >
  github.event.workflow_run.conclusion == 'success' &&
  (github.event.workflow_run.head_repository.full_name != github.repository ||
   github.event.workflow_run.actor.login == 'dependabot[bot]')
```

The Sonar workflow must only run for builds that ran the action, or it reports
that the build left nothing to analyse. If the build workflow skips some
changes, skip them with `paths-ignore` on the build's trigger so the Sonar
workflow doesn't start; if the build skips the action on some events, mirror
that in the Sonar job, e.g. `github.event.workflow_run.event != 'schedule'`.

### Only for forks, next to another Sonar setup

If your own pull requests and pushes are already analysed another way, e.g. with
Sonar's own action, use this action only for forks: in the build with
`if: github.event.pull_request.head.repo.fork`, and in the Sonar job with
`github.event.workflow_run.head_repository.fork`. Dependabot's pull requests are
not forks but go without secrets too: add `github.actor == 'dependabot[bot]'` to
both conditions if your other setup needs a token.

### Your own checkout

The Sonar workflow checks out the analysed commit itself. With `checkout: false`
you do it, e.g. for submodules or Git LFS. The checkout must then be at the
analysed commit, with full history, without persisted credentials, and with
`origin` pointing at your repository, where Sonar finds the base branch:

```yaml
- uses: actions/checkout@v7
  with:
    ref: ${{ github.event.workflow_run.head_sha }}
    fetch-depth: 0
    persist-credentials: false
    submodules: true
- uses: evaristegalois11/sonar-fork-analysis@v2
  with:
    checkout: false
    # …
```

### Dependabot

Dependabot's pull requests run without your Actions secrets, like forks, so they
take the same path and get analysed by the Sonar workflow.

## Limitations

- Maven and Gradle builds only.
- Dependency analysis (SCA) and the engine's build-system autoconfiguration are
  off on fork pull requests, because both run the project's build tools. See
  [security](docs/security.md#what-stays-off-on-the-fork-path).
- Some settings stay behind on the fork path: anything about the server, the
  scanner or the branch, and anything that would run a program. The build warns
  about each one. See [security](docs/security.md#what-the-fork-path-carries).
- `sonar.region` isn't carried, so the fork path can't reach SonarQube Cloud's
  US region yet.
- The wrapper (`mvnw`, `gradlew`) is only looked for in `working-directory`, not
  above it, and Windows runners never run `mvnw.cmd` or `gradlew.bat`.
- Platforms without a scanner build that bundles Java need Java on the `PATH`;
  Alpine images can't run the bundled Java. Projects on a newer Java than the
  scanner's may need `setup-java` and `-Dsonar.java.jdkHome` in
  `build-arguments`.
- SonarQube Server must support pull request analysis. The action is checked
  against SonarQube Cloud and the latest SonarQube Community Build.

## Migrating from v1

v1 stays on its tags but gets no fixes, security ones included: move to v2. v2
builds the project itself, so drop your own build step and the `java-version`
and `distribution` inputs, set up Java with `actions/setup-java` instead, and
add `sonar-organization` to both workflows. `github-token`, `sonar-token` and
`project-key` keep their meaning.

## Development

`npm run all` formats, lints, type-checks, tests and bundles into `dist/`, which
is committed. Tests that use the real scanner download it and SonarQube's
engines, and need Java and `unzip`: run them with `npm run test:scanner`. When
Sonar ships an engine that starts processes in new places, they fail until
`__tests__/java/engine-processes-*.txt` is reviewed.

To run the action on your machine, copy `.env.example` to `.env`, adjust it, and
run `npm run local`.

Dependabot pull requests that update the action's runtime dependencies fail CI
until `dist/` is rebuilt: run `npm ci && npm run bundle` on the pull request's
branch, or commit the `dist` artifact the failed run uploads.

A third-party action added to a workflow must also be added to the repository's
allowed actions.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). Licensed
under [MIT](LICENSE).
