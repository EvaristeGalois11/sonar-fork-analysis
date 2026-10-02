# Troubleshooting

Every message the action prints, by where you see it. Warnings and notices
appear as annotations on the run; errors fail the step.

## Inputs

- **Input required: project-key** — Set `project-key` in both workflows.
- **Invalid project key '…'** — Project keys may only hold letters, digits, `.`,
  `_`, `:` and `-`.
- **Unknown mode '…'** / **Unknown build tool '…'** / **Input … must be true or
  false** — A typo in `mode`, `build-tool` or `checkout`; see
  [inputs](../README.md#inputs).

## Build workflow

- **Refusing to build on …, which runs with the repository's secrets; trigger
  the build on pull_request instead.** — The build workflow runs on
  `pull_request_target` or `issue_comment`, where a fork's code would run with
  your secrets. Use `pull_request`.
- **No Sonar token available, set the sonar-token input. On pull requests from
  forks, use mode auto.** — `mode: direct` needs a token, which fork pull
  requests never have. Use `auto`.
- **Direct analysis on workflow_run builds the checked-out code with the Sonar
  token; make sure it is not code from a fork.** — You forced `mode: direct` in
  a `workflow_run` workflow. Only do that for code you trust.
- **No Maven or Gradle build found in '…', set the working-directory input** /
  **Both Maven and Gradle build files found in '…', set the build-tool input** —
  Point `working-directory` at the build, or pick the tool with `build-tool`.
- **The Maven build failed with exit code …** / **The Gradle build failed with
  exit code …** — The build itself failed; its output is in the log above.
- **The Gradle build has no 'sonar' task: apply the org.sonarqube plugin** /
  **The Gradle build succeeded but no Sonar analysis ran: apply the
  org.sonarqube plugin** — Apply the
  [Gradle plugin](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/sonarscanner-for-gradle/).
- **The Maven build succeeded but no Sonar analysis ran: check that sonar.skip
  is not set** — Something sets `sonar.skip`.
- **The … build succeeded but its Sonar plugin wrote no analysis settings; the
  plugin may be too old to support simulation mode** — The fork path needs a
  recent Sonar plugin; update it in your build.
- **The analysis of pull requests leaves out these settings: …** — These
  settings stay in the build; see
  [what the fork path carries](security.md#what-the-fork-path-carries). If the
  analysis needs one, pass it with `build-arguments` in the Sonar workflow.
- **Dropped … entry outside the workspace: …** — A path in the build's settings
  points outside the workspace and the runner's home, so its files aren't
  shipped.
- **This repository keeps artifacts … days: if this build completes more than …
  days after its analysis, e.g. after a deployment approval, the fork path will
  report that it left nothing to analyse.** — A direct analysis leaves a marker
  for the Sonar workflow, which can only outlive the build by your repository's
  artifact retention. Raise it to 35 days, the longest a run can last, if your
  builds can wait that long.
- **Could not note the direct analysis for the fork path: …** — The marker
  couldn't be uploaded, so the Sonar workflow will report that the build left
  nothing to analyse. If it adds that analyses in one workflow need distinct
  project keys, two steps in the run analysed the same project key.

## Sonar workflow

- **No … artifact: the build left nothing to analyse.** — The build didn't run
  the action for this project key: check that both workflows use the same
  `project-key`, and that the Sonar workflow only runs for builds that ran the
  action (see [recipes](../README.md#skipping-runs-with-nothing-to-do)).
- **No open pull request has … as its head any more; a newer run analyses it.**
  — The pull request moved on before the analysis started. Nothing to do.
- **The run analyses …, not this repository, and is not for a pull request.** —
  A build of another repository's branch, e.g. a push to a fork's own branch,
  triggered the Sonar workflow. Nothing to do.
- **… open pull requests have this head, analysing #…** — Several pull requests
  share the analysed commit; the build's pull request number decides when it
  can.
- **No Sonar token available, set the sonar-token input.** — Pass `sonar-token`
  to the action in the Sonar workflow.
- **… was prepared by an incompatible version of this action** — Use the same
  version of the action in both workflows.
- **The workspace is not empty: remove your checkout step, or set checkout to
  false to keep it** — The action checks out the pull request itself.
- **The checkout is at … but the analysis is for …** / **The checkout is shallow
  …** / **The checkout stored credentials in .git/config …** — With
  `checkout: false`, your checkout must meet the
  [requirements](../README.md#your-own-checkout).
- **git … failed with exit code …** — Checking out the pull request failed;
  Git's message follows.
- **Could not look up the pull request: GitHub answered …** — The job needs
  `pull-requests: read`.
- **The artifact contains a link or special file: …** — The upload was altered;
  nothing is analysed.
- **The artifact gives … no base directory in the checkout** / **Invalid module
  id …** — The upload's module structure is one the analysis can't check safely,
  or was altered. Real Maven and Gradle builds don't produce these; if yours
  does, report it.
- **Dropped settings a build never ships: …** — The upload was altered, or the
  two workflows run different versions of the action.
- **Dropped …: it holds a placeholder the scanner would expand** / **Dropped …:
  it holds half of a character** / **Dropped …: the scanner reads it as one
  path** / **Dropped … entry: …** — The setting, or one of its paths, isn't
  something the scanner would read the way it was checked, or points outside the
  checkout; see [security](security.md#what-the-sonar-workflow-does).
- **Removed …: a link leading out of the checkout** — A link in the pull request
  points outside it, or nowhere; the analysis goes on without it.
- **Skipped …: …** — A file from the upload wasn't unpacked: it would land
  inside `.git`, inside the sources, over an existing file, or through a link,
  or it is a `sonar-project.properties`.
- **The downloaded scanner has SHA-256 …, expected …** — The scanner download
  was corrupted or tampered with; the run stops.
- **The Sonar scanner failed with exit code …** — The analysis itself failed;
  the scanner's output is in the log above.
- **Could not post the … status: …** — The job lacks `statuses: write`, or
  GitHub refused the status; the analysis is unaffected.

## Commit status

- **Analysing** / **Analysed** — The Sonar workflow is running, then done; the
  link leads to the run.
- **The build left nothing to analyse** — See the Sonar workflow message above.
- **The analysis failed, see the run** — Any other error; the run's log has it.

## Running locally

- **Not running in GitHub Actions, …** — The action ran outside a workflow, e.g.
  with `@github/local-action`, and kept the upload or the analysis local.
