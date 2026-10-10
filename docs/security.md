# Security

Code in a pull request from a fork hasn't been reviewed, so GitHub builds it
without your secrets. This action keeps it that way. The build runs without the
Sonar token. A build can read anything in its job, so the action refuses to
prepare when you pass it the token. The Sonar workflow has the token but never
runs anything from the pull request.

Everything the Sonar workflow gets from the pull request could be hostile: the
files in the checkout and the artifact the pull request's build left behind.
This page explains how the action handles them and what's left for you to
decide.

## What the Sonar workflow does

It never runs Maven, Gradle, npm or a wrapper script. It checks out the pull
request, unpacks the artifact and runs the Sonar scanner, which reads the pull
request's files but never runs them.

**The checkout.** The action checks out the pull request itself, without ever
writing the GitHub token to disk. `origin` points at your repository, because
that's where Sonar looks for the base branch. The pull request's commit comes
from your repository too. GitHub keeps a copy of every pull request's head
there. The action never contacts the fork. Then it removes two kinds of files
the scanner would otherwise trust:

- Links that lead outside the checkout. The scanner follows them, so a link to
  `/proc/self` would get the scanner's own environment, token included, indexed
  and sent to Sonar. A link could hide behind a file name that isn't valid
  UTF-8, so the action refuses such names.
- `sonar-project.properties` files, which the scanner would read as
  configuration.

**The artifact.** The action refuses an artifact with links, special files or
file names that aren't valid UTF-8 in it. It unpacks the build output next to
the sources, never over an existing file or through a link. Into the source
directories it only adds report files that the settings name and type
information in `node_modules` (declaration, `package.json` and `tsconfig`
files). Through a link or a report setting, a fork can still add files that
Sonar analyses as part of its code. That only changes its own pull request's
results, as committing those files would. The analyzers read the type
information to learn the types the code uses and by default never report on it
as part of the project. The action also recreates the links a Node project had
in `node_modules`. It only recreates links that sit in a `node_modules`
directory and lead to a directory in the checkout, never into `.git`. A fork
could commit links like these itself.

**The settings.** The build's settings go through the same
[allowlist](#what-the-fork-path-carries) again, and every path in them must lead
inside the checkout or the action's private home. That's where the action puts
libraries from the build's home, such as Maven's `~/.m2`. The action also drops
any value the scanner might read differently from how it was checked. The main
example is a `${…}` placeholder: the scanner expands those, so
`${env.SONAR_TOKEN}` would turn into the token. Quotes, control characters, path
patterns and stray spaces are dropped for the same reason. Modules are worked
out the same way the scanner's engine does it, and each one needs its own base
directory inside the checkout.

Then the action sets the settings that matter for safety itself, whatever the
artifact says: the project key, the analysed commit, the working directory, the
languages it analyses and the
[features that stay off](#what-stays-off-on-the-fork-path).

**The analyzers.** On the fork path, only the analyzers of the
[languages the sample projects test](../README.md#languages-on-pull-requests-from-forks)
run. Sonar's engine loads a language's analyzer only once it finds a file of
that language. So the action asks the server which languages it knows. For each
of the others, it sets `sonar.lang.patterns.<language>` to a pattern no file can
match. Files of those languages are still indexed, but with no language. Their
analyzers never load in the job that has the token. If the server doesn't list
its languages, the analysis stops. The tests check the engine habits this relies
on. They run against SonarQube Cloud's engine and SonarQube's.

The always-loaded `iac` plugin also sorts YAML and JSON files by their content.
For example, it finds CloudFormation and Ansible files that way. Turning
languages off doesn't stop that. Those sensors only read files.

The analyzers of the tested languages only read files. For JavaScript and
TypeScript, this was tested against Sonar's real analyzer with a project that
tried every way to get its own code run. The analyzer used its own Node.js and
TypeScript. It ran none of the project's configuration files (ESLint, Babel,
TypeScript and others) and loaded no code from its `node_modules`. It only read
`tsconfig` files and type declarations as data. Two Node test fixtures, one
installed with npm and one with pnpm, keep checking this against SonarQube
Cloud's analyzer, see
[keeping up with the scanner](#keeping-up-with-the-scanner). Analyzers for other
languages haven't been checked. Some might start other programs. If you turn
their language on with `build-arguments`, the action guarantees nothing for
them.

**The scanner.** It runs in an empty directory of its own. Its environment holds
the Sonar token, but not the action's inputs, the runner's own tokens or
variables like `GITHUB_ENV`. That limits what a mistake can reach, but it isn't
a security boundary: a program running there could still read the action's own
environment.

## What the fork path carries

The build only passes on the settings an analysis needs, picked by name. These
are the project's structure (modules, sources, tests, binaries, libraries),
report paths for coverage, tests and external issues, per-language settings and
exclusions. Everything else stays behind. That includes the server, the token
and the project key, scanner and branch settings, and anything that would start
a program, like a JDBC driver or Node.js. It also includes the settings that
decide each file's language: file suffixes and patterns, and
`sonar.lang.patterns.*`. The Sonar workflow sets its own. See
[the analyzers](#what-the-sonar-workflow-does).

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
  A fork's build could leave something behind on the machine, such as tampered
  tools or a tampered Sonar cache. GitHub
  [advises against self-hosted runners for public repositories](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)
  anyway.
- Pin the action to a commit SHA.
- Give the Sonar job only the permissions from the [setup](../README.md#setup),
  and no extra secrets or steps.
- Don't add caching to the Sonar job or give it write access to the cache with
  `cache-mode`. The one exception is
  [the Sonar scanner's directory](../README.md#caching-the-sonar-scanner): the
  action checks the scanner against its checksum every time.
  [By default](https://github.blog/changelog/2026-06-26-read-only-actions-cache-for-untrusted-triggers/),
  GitHub only lets `workflow_run` jobs read the default branch's cache, so they
  can't poison later builds.
- Keep the Sonar token away from builds of pull requests from forks and from
  Dependabot. GitHub withholds it from those builds unless you change one of two
  settings. Leave both alone: don't let a private repository send secrets to
  pull requests from forks, and don't add `SONAR_TOKEN` to Dependabot's secrets.
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
builds the same modules and that no part of the engine beyond the reviewed ones
can start a program. They also check three habits of the engine. A language's
`sonar.lang.patterns` setting replaces its own patterns. The pattern that turns
a language off matches no file. The engine loads analyzers only for the
languages it finds.

The analysis of the test fixtures also sets traps. Fake build tools on the
`PATH` fail the run if the analysis ever starts one. The fixtures' Maven and
Gradle wrappers need Java, `wget` and `curl`. Fakes of these fail the run too.
So do booby-trapped Gradle settings in the fixtures. The Node fixtures add
booby-trapped configuration files and packages, which fail the run if the
JavaScript analyzer ever loads them. One fixture also holds a Python file. The
direct analysis must report its issue. The fork path must not analyse it.

Older SonarQube Server versions and commercial editions aren't tested.

## v1

v1 runs Maven or Gradle on the pull request's checkout in the job that holds the
Sonar token, so a fork's code can run with the token. Until June 2026 that code
could also save entries in your default branch's Actions cache, which later
builds restore.

v1 gets no more fixes, so plan the move to v2 now. If v1 has analysed pull
requests from forks, also rotate your Sonar token and delete your repository's
Actions caches as a precaution. Your repository's **Actions** tab lists them
under **Caches** in its sidebar. Delete each one there, or all at once with
`gh cache delete --all`.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
