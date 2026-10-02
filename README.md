# Sonar Fork Analysis

[![CI](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/ci.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/ci.yml)
[![Fixtures](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/fixtures.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/fixtures.yml)
[![Scanner](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/scanner.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/scanner.yml)
[![CodeQL](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/codeql.yml/badge.svg)](https://github.com/EvaristeGalois11/sonar-fork-analysis/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/EvaristeGalois11/sonar-fork-analysis/badge)](https://scorecard.dev/viewer/?uri=github.com/EvaristeGalois11/sonar-fork-analysis)
![Coverage](./badges/coverage.svg)

<!-- prettier-ignore -->
> [!NOTE]
> v2 is under development and not released yet, so `@v2` doesn't resolve. This
> README describes v2.

Runs Sonar analysis, with coverage and test results, on pull requests from
forks.

GitHub doesn't give secrets to workflows triggered by a fork, so the usual Sonar
setup can't analyse their pull requests. This action splits the work in two. The
build workflow builds the pull request without the Sonar token. A second
workflow then analyses the result with the token, without running any of the
pull request's code. It's the split
[Sonar's documentation describes for forks](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/ci-based-analysis/github-actions-for-sonarcloud#analyzing-fork-pull-requests),
packaged for Maven and Gradle. Binaries, libraries, coverage, test reports and
the settings your build defines all carry over.

If you don't need coverage on fork pull requests, SonarQube Cloud's
[Automatic Analysis](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/automatic-analysis/)
handles forks with no setup. It has no coverage, doesn't support monorepos, and
analyses some languages in less depth.

## Documentation

- [Security](docs/security.md): what the analysis trusts, and how to harden your
  setup.
- [Troubleshooting](docs/troubleshooting.md): what each message means.

## How it works

```mermaid
flowchart LR
  fork(["Pull request from a fork"]) --> prepare
  subgraph build["Build workflow, no secrets"]
    prepare["prepare mode<br/>builds the pull request<br/>and uploads the output"]
  end
  prepare -- "workflow_run" --> analyze
  subgraph sonar["Sonar workflow, Sonar token"]
    analyze["analyze mode<br/>checks the upload and<br/>runs only the scanner"]
  end
  own(["Push, or pull request<br/>from your repository"]) --> direct
  subgraph trusted["Build workflow, Sonar token"]
    direct["direct mode<br/>builds and analyses"]
  end
```

On a pull request from a fork:

1. Your build workflow runs without the Sonar token. The action builds the
   project with Maven or Gradle, and has Sonar's build plugin work out the
   analysis settings without running the analysis. It uploads the compiled
   classes, libraries, coverage and test reports, together with those settings,
   as an artifact.
2. When the build finishes, GitHub starts your Sonar workflow through
   `workflow_run`. It runs in your repository, so it has the Sonar token.
3. The action checks out the pull request, checks the uploaded settings against
   an allowlist, and runs the Sonar scanner on the sources and the build output.
   It never runs the build or anything else from the pull request. Sonar shows
   the results on the pull request as usual.

On pushes and pull requests from your own repository, the build has the token,
so the action analyses straight away, as Sonar's own Maven and Gradle plugins
would. The Sonar workflow still starts after the build, but has nothing to do.

Dependabot's pull requests run without your Actions secrets, like forks, so they
take the fork path too.

You don't have to pick any of this. The `mode` input defaults to `auto`, which
chooses the right part from where the action runs and whether it has a token.

## Setup

1. Create a Sonar token and save it as the repository secret `SONAR_TOKEN`.
   SonarQube Cloud's free plan only has personal tokens, so create a dedicated
   one named after your repository, with an expiry date. Paid plans can use a
   [scoped organization token](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-organization/scoped-organization-tokens)
   with only _Execute analysis_ on the project. A scoped token without an expiry
   date lapses after 60 days without use.
2. Gradle builds need the `org.sonarqube` plugin. Maven builds need nothing.
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
         # Your existing checkout and Java setup. Sonar needs the full history.
         - uses: actions/checkout@v7
           with:
             persist-credentials: false
             fetch-depth: 0
         - uses: actions/setup-java@v6
           with:
             distribution: temurin
             java-version: 21
         # Add this in place of your build step.
         - uses: evaristegalois11/sonar-fork-analysis@v2
           with:
             project-key: my-org_my-project
             sonar-organization: my-org
             sonar-token: ${{ secrets.SONAR_TOKEN }}
   ```

   The action runs the build itself, `verify` for Maven and `check` for Gradle
   (see `build-goals`). Trigger the workflow on `pull_request`, not
   `pull_request_target`. With `pull_request_target`, a fork's code would run
   with your secrets, so the action refuses to build there.

4. Add the Sonar workflow, triggered by the build:

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

   Use the same `project-key` in both workflows, because it also names the
   upload. `statuses: write` is optional, see
   [commit statuses](#commit-statuses-and-required-checks).

If you pin your other actions to commit SHAs, pin this one too. The
[security page](docs/security.md#hardening-your-setup) has more hardening
advice.

### Which commit the build tests

On a pull request, `actions/checkout` checks out a merge of the pull request
into the base branch, but the Sonar workflow analyses the pull request's head.
This rarely matters. It only affects files that changed both in the pull request
and on the base branch since the pull request branched off. Their binaries and
coverage then come from slightly different code, and the only visible sign is
usually a scanner warning such as _Cannot import coverage information for file_.

If you want the two to match exactly, check out the head in the build:

```yaml
- uses: actions/checkout@v7
  with:
    persist-credentials: false
    fetch-depth: 0
    ref: ${{ github.event.pull_request.head.sha }}
```

This changes what your whole build tests on pull requests, so only do it if
you're happy with that.

## Inputs

| Input                | Required             | Default            | Description                                                                                                                                                                                              |
| -------------------- | -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-key`        | Yes                  |                    | The Sonar project key. Use the same one in the build and the Sonar workflow.                                                                                                                             |
| `sonar-organization` | For SonarQube Cloud  |                    | The Sonar organization.                                                                                                                                                                                  |
| `sonar-token`        | Yes                  |                    | The Sonar token. It's empty on pull requests from forks, which makes the action take the fork path.                                                                                                      |
| `sonar-host-url`     | For SonarQube Server |                    | The server URL. Leave it empty for SonarQube Cloud, or to use the `SONAR_HOST_URL` environment variable. Direct analyses also fall back to the build's own `sonar.host.url`, the Sonar workflow doesn't. |
| `mode`               | No                   | `auto`             | `auto`, or `direct`, `prepare`, `analyze` to force one part.                                                                                                                                             |
| `working-directory`  | No                   | `.`                | The directory holding the Maven or Gradle build.                                                                                                                                                         |
| `build-tool`         | No                   | `auto`             | `auto`, `maven` or `gradle`.                                                                                                                                                                             |
| `build-goals`        | No                   | `verify` / `check` | Maven goals or Gradle tasks to run, one per line.                                                                                                                                                        |
| `build-arguments`    | No                   |                    | Extra build flags, one per line. In the Sonar workflow they go to the scanner instead, such as `-Dsonar.projectName=App`, and relative paths don't point into the checkout.                              |
| `checkout`           | No                   | `true`             | Whether the Sonar workflow checks out the analysed commit. `false` to do it yourself, see [your own checkout](#your-own-checkout).                                                                       |
| `github-token`       | No                   | `github.token`     | Downloads the upload and finds the pull request.                                                                                                                                                         |

## Commit statuses and required checks

Sonar posts its own check on every analysed pull request, such as _SonarCloud
Code Analysis_. On pull requests from forks it arrives once the Sonar workflow
has run, a little after the build's own checks. To block merging until the
analysis passes, require that check in your branch rules, with the Sonar app as
its source. If the fork path fails, the check never arrives, so merging stays
blocked.

With `statuses: write`, the Sonar workflow also posts a status called _Sonar
fork analysis (your project key)_, so you can see why a check is missing. It's
pending while the analysis runs, then success or failure, and links to the run.
It's only posted for pull requests that take the fork path, so don't require it,
or pull requests from your own repository can never be merged.

## Recipes

### Several projects

Run the action once per project, each with its own project key and
`working-directory`, for example with a matrix. In the build workflow:

```yaml
jobs:
  build:
    strategy:
      matrix:
        include:
          - project-key: my-org_service-a
            working-directory: service-a
          - project-key: my-org_service-b
            working-directory: service-b
    runs-on: ubuntu-latest
    steps:
      # Checkout and Java setup as in the setup.
      - uses: evaristegalois11/sonar-fork-analysis@v2
        with:
          project-key: ${{ matrix.project-key }}
          working-directory: ${{ matrix.working-directory }}
          sonar-organization: my-org
          sonar-token: ${{ secrets.SONAR_TOKEN }}
```

The Sonar workflow only needs the project keys:

```yaml
jobs:
  sonar:
    if: github.event.workflow_run.conclusion == 'success'
    strategy:
      matrix:
        project-key: [my-org_service-a, my-org_service-b]
    runs-on: ubuntu-latest
    # Permissions as in the setup.
    steps:
      - uses: evaristegalois11/sonar-fork-analysis@v2
        with:
          project-key: ${{ matrix.project-key }}
          sonar-organization: my-org
          sonar-token: ${{ secrets.SONAR_TOKEN }}
```

If the build skips a project, for example because none of its files changed,
that project's Sonar job ends without doing anything.

### Skipping runs with nothing to do

The Sonar workflow runs after every build, and stops straight away when the
build analysed directly. To skip it completely, run its job only for forks and
Dependabot:

```yaml
if: >
  github.event.workflow_run.conclusion == 'success' &&
  (github.event.workflow_run.head_repository.full_name != github.repository ||
   github.event.workflow_run.actor.login == 'dependabot[bot]')
```

### Builds that don't always run the action

The Sonar workflow expects every build it follows to have run the action.
Otherwise it reports that the build left nothing to analyse. If the build
ignores some changes, ignore them in its trigger, so the Sonar workflow never
starts:

```yaml
on:
  pull_request:
    paths-ignore: ['docs/**']
```

If the build skips the action on some events, skip them in the Sonar job too:

```yaml
if: >
  github.event.workflow_run.conclusion == 'success' &&
  github.event.workflow_run.event != 'schedule'
```

### Only for forks, next to another Sonar setup

If you already analyse your own pull requests and pushes another way, such as
with Sonar's own action, you can use this action for forks and Dependabot only.
In the build, run it only on those pull requests, and without a token, so it
always takes the fork path:

<!-- prettier-ignore -->
```yaml
- uses: evaristegalois11/sonar-fork-analysis@v2
  if: >
    github.event.pull_request.head.repo.fork ||
    github.actor == 'dependabot[bot]'
  with:
    project-key: my-org_my-project
    sonar-organization: my-org
```

In the Sonar workflow, use the job condition from
[skipping runs](#skipping-runs-with-nothing-to-do).

### Your own checkout

The action checks out the analysed commit itself. Set `checkout: false` to do it
yourself, for example to get submodules or Git LFS files. Your checkout must be
at the analysed commit, with full history and no persisted credentials. Its
`origin` must point at your repository, which is where Sonar finds the base
branch.

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

## Used by

- [Instancio](https://github.com/instancio/instancio), a Maven build with 38
  modules:
  [build workflow](https://github.com/instancio/instancio/blob/main/.github/workflows/build.yml)
  and
  [Sonar workflow](https://github.com/instancio/instancio/blob/main/.github/workflows/sonar.yml).

## Limitations

- Only Maven and Gradle builds are supported.
- On the fork path, the build collects its settings through the Sonar plugins'
  simulation mode (`sonar.scanner.internal.dumpToFile`). Sonar uses it in its
  own tests but doesn't document it, so a plugin release could change it. If it
  stops working, the build fails with _the plugin may be too old to support
  simulation mode_. This project's tests keep up with the latest plugins, so
  such a change should show up here first.
- Dependency analysis (SCA) and the engine's build-system autoconfiguration are
  off on fork pull requests, because both run the project's build tools. See
  [what stays off](docs/security.md#what-stays-off-on-the-fork-path).
- Settings about the server, the scanner or the branch, and settings that would
  start a program, don't reach the Sonar workflow. The build warns about each
  one. See
  [what the fork path carries](docs/security.md#what-the-fork-path-carries).
- The build's `sonar.region` isn't carried. For SonarQube Cloud's US region, add
  `-Dsonar.region=us` to `build-arguments` in the Sonar workflow.
- The action looks for `mvnw` and `gradlew` only in `working-directory`, not in
  parent directories. On Windows runners it never runs `mvnw.cmd` or
  `gradlew.bat`.
- Where the scanner has no build with Java bundled, it needs Java on the `PATH`.
  Alpine images can't run the bundled Java. Projects on a newer Java than the
  scanner's may need `setup-java` and `-Dsonar.java.jdkHome` in
  `build-arguments`.
- SonarQube Server needs an edition that supports pull request analysis. The
  action is tested against SonarQube Cloud and the latest SonarQube Community
  Build.

## Migrating from v1

v1 stays on its tags but gets no more fixes, security fixes included. Move to
v2.

v2 runs the build itself. Remove your build step and the `java-version` and
`distribution` inputs, and set up Java with `actions/setup-java` instead. Add
`sonar-organization` to both workflows. `github-token`, `sonar-token` and
`project-key` work as before.

## Development

`npm run all` formats, lints, type-checks, tests and bundles into `dist/`, which
is committed.

`npm run test:scanner` runs the tests against the real scanner. They download
the scanner and SonarQube's engines, and need Java and `unzip`. If Sonar ships
an engine that starts processes in new places, they fail until someone reviews
`__tests__/java/engine-processes-*.txt`.

To run the action locally, copy `.env.example` to `.env`, edit it, and run
`npm run local`.

Dependabot pull requests that update runtime dependencies fail CI until `dist/`
is rebuilt. Run `npm ci && npm run bundle` on the branch, or commit the `dist`
artifact the failed run uploads.

Third-party actions added to a workflow must also be added to the repository's
allowed actions.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). Licensed
under [MIT](LICENSE).

This project is not affiliated with or endorsed by SonarSource. Sonar, SonarQube
and SonarCloud are trademarks of SonarSource.
