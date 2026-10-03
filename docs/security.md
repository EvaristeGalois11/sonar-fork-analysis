# Security

Code in a pull request from a fork hasn't been reviewed, so GitHub builds it
without your secrets. This action keeps it that way. The build runs without the
Sonar token. The Sonar workflow has the token but never runs anything from the
pull request.

Everything the Sonar workflow gets from the pull request could be hostile: the
files in the checkout and the artifact the pull request's build left behind.
This page explains how the action handles them and what's left for you to
decide.

## What the Sonar workflow does

It never runs Maven, Gradle or a wrapper script. It checks out the pull request,
unpacks the artifact and runs the Sonar scanner, which only reads files.

**The checkout.** The action checks out the pull request itself, without ever
writing the GitHub token to disk. `origin` points at your repository, because
that's where Sonar looks for the base branch. Then it removes two kinds of files
the scanner would otherwise trust:

- Links that lead outside the checkout. The scanner follows them, so a link to
  `/proc/self` would get the scanner's own environment, token included, indexed
  and sent to Sonar.
- `sonar-project.properties` files, which the scanner would read as
  configuration.

**The artifact.** The action refuses an artifact with links or special files in
it. It unpacks the build output next to the sources, never over an existing file
or through a link.

**The settings.** The build's settings go through the same
[allowlist](#what-the-fork-path-carries) again, and every path in them must lead
inside the checkout. The action also drops any value the scanner might read
differently from how it was checked. The main example is a `${…}` placeholder:
the scanner expands those, so `${env.SONAR_TOKEN}` would turn into the token.
Quotes, control characters, path patterns and stray spaces are dropped for the
same reason. Modules are worked out the same way the scanner's engine does it,
and each one needs its own base directory inside the checkout.

Then the action sets the settings that matter for safety itself, whatever the
artifact says: the project key, the analysed commit, the working directory and
the [features that stay off](#what-stays-off-on-the-fork-path).

**The scanner.** It runs in an empty directory of its own. Its environment holds
the Sonar token, but not the action's inputs, the runner's own tokens, or
variables like `GITHUB_ENV` that would let it change later steps.

## What the fork path carries

The build only passes on the settings an analysis needs, picked by name. These
are the project's structure (modules, sources, tests, binaries, libraries),
report paths for coverage, tests and external issues, per-language settings such
as file suffixes, and exclusions. Everything else stays behind. That includes
the server, the token and the project key, scanner and branch settings, and
anything that would start a program, like a JDBC driver or Node.js.

Reports are recognised by their name (`…reportPaths` and similar), so a report
from a tool Sonar adds later works without a new release of this action.
Settings ending in `Paths` are checked one entry at a time, on the assumption
that the scanner reads them as lists. Every documented one is.

The filtering can produce two warnings:

- _The analysis of pull requests leaves out these settings_, from the build,
  when it leaves something behind. If the analysis needs it, pass it with
  `build-arguments` in the Sonar workflow. That's your own configuration, so
  it's trusted.
- _Dropped settings a build never ships_, from the Sonar workflow, when the
  artifact holds a setting no build would produce. Either someone tampered with
  the artifact, or the two workflows run different versions of the action.

## What stays off on the fork path

Two Sonar features work by running the project's own build tools. On the fork
path those tools come from the pull request, so the Sonar workflow always turns
the features off:

- **Dependency analysis** (SCA, part of Sonar's Advanced Security) runs `mvnw`,
  `gradlew` or `npm` to list dependencies. Fork pull requests don't get it, but
  your own pushes and pull requests still do, because the build analyses them
  directly. For fork pull requests, GitHub's
  [dependency review action](https://github.com/actions/dependency-review-action)
  can check dependencies without any secrets.
- **Build-system autoconfiguration**, in SonarQube Cloud's engine, can run
  `mvnw` to configure the project.

Don't turn either back on with `build-arguments` in the Sonar workflow, for
example with `-Dsonar.sca.enabled=true`. That would run the pull request's build
tools with your token.

## What a fork can still influence

A fork controls its own pull request's code and build, so it also controls that
pull request's analysis. It can fake coverage and test results, exclude files,
ignore issues or skip the analysis, and nothing will show it. It can't affect
other pull requests or your branches. So take a fork's Sonar result as
information about the pull request, not as a review of it.

## Hardening your setup

- Don't run fork builds on self-hosted runners that also run the Sonar workflow.
  A fork's build could leave something behind on the machine, such as a tampered
  copy of the scanner the action caches there. GitHub
  [advises against self-hosted runners for public repositories](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)
  anyway.
- Pin the action to a commit SHA.
- Give the Sonar job only the permissions from the [setup](../README.md#setup),
  and no extra secrets or steps.
- Don't add caching to the Sonar job, and don't give it write access to the
  cache with `cache-mode`. GitHub only lets `workflow_run` jobs read the default
  branch's cache, so they can't poison later builds.
- Use a dedicated Sonar token, as the [setup](../README.md#setup) describes.
- If you want an extra layer, require approval before workflows from outside
  contributors run (Settings → Actions → General). The analysis is safe without
  it.

If you use `checkout: false`, CodeQL may flag your checkout step with
`actions/untrusted-checkout`, which warns about pull request code checked out in
a privileged job. Nothing in that job runs the checked-out code, so you can
dismiss the alert. Just make sure any step you add doesn't run it either.

## Keeping up with the scanner

Sonar updates its scanner on its own schedule, and some updates matter here.
Dependency analysis, build-system autoconfiguration and the engine's habit of
running `dotnet` to collect analytics all arrived that way.

So this project tests against the real thing, on every pull request and once a
week: the scanner CLI it pins, together with the engines that SonarQube Cloud
and the latest SonarQube Community Build currently serve. The tests check that
the scanner reads settings exactly as the action checked them, that the engine
builds the same modules and that the parts of the engine able to start a program
haven't changed since they were last reviewed.

The analysis of the test fixtures also sets traps. Fake build tools on the
`PATH` fail the run if the analysis ever starts one, and so do booby-trapped
wrappers and Gradle settings in the fixtures.

Older SonarQube Server versions and commercial editions aren't tested.

## v1

v1 runs Maven or Gradle on the pull request's checkout in the job that holds the
Sonar token, so a fork can run code with the token. It gets no fixes. Move to
v2.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
