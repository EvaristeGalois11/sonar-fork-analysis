# Security

A pull request from a fork runs code you haven't reviewed, and GitHub builds it
without your secrets. This action keeps it that way. The build has no Sonar
token, and the Sonar workflow, which has the token, never runs the pull
request's code.

The Sonar workflow treats everything it takes from the pull request as hostile.
That includes the upload, which the pull request's build produced, and the
checkout, which holds the pull request's files.

## What the Sonar workflow does

It runs no build and no wrapper script. It checks out the pull request, unpacks
the upload and runs the Sonar scanner on the result. Along the way, it:

- Checks out the pull request's head itself. The GitHub token reaches Git
  through its environment and is never written to disk, and `origin` points at
  your repository.
- Removes links in the checkout that lead outside it. The scanner follows links
  into directories, so a link to `/proc/self` would make it index and upload its
  own environment, token included.
- Removes `sonar-project.properties` files, which the scanner would read without
  any checks.
- Refuses an upload that holds links or special files, and filters its settings
  through the same [allowlist](#what-the-fork-path-carries) the build used.
- Requires every path in the settings to resolve inside the checkout after
  following links. Build output may also resolve inside the action's own
  directory.
- Refuses settings the scanner would read differently from how the action
  checked them. These are `${…}` placeholders, which the scanner expands, so
  `${env.SONAR_TOKEN}` would become the token. Also path patterns, quotes,
  control characters, leading or trailing spaces, half of a Unicode surrogate
  pair, and commas in settings that hold a single path.
- Works out the module structure the same way the scanner's engine does, and
  requires every module to have a base directory inside the checkout.
- Unpacks build output without overwriting sources or writing through links.
- Overrides the settings that decide where results go and what runs: the project
  key, the analysed revision, the working directory, and the
  [features that stay off](#what-stays-off-on-the-fork-path).
- Runs the scanner in an empty directory, with the Sonar token only in its
  environment. The scanner doesn't see the action's inputs, the runner's
  internal tokens, or the files a step uses to talk to the runner.

## What the fork path carries

The build passes on only the settings an analysis needs, chosen by name:

- the project structure: modules, sources, tests, binaries, libraries and base
  directories
- any setting named like a report path (`…reportPath`, `…reportPaths`,
  `…reportsPath`), which covers coverage, test results and external issues from
  any tool
- per-language settings: file suffixes and patterns, activation, exclusions and
  language versions
- inclusions, exclusions, issue exclusions, and the project's name, description,
  version and links

Nothing else is carried. That rules out the server, token, organization, region,
project and module keys, working directory, scanner settings
(`sonar.scanner.*`), branch and pull request settings, and SCM settings. It also
rules out anything that starts a program, such as JDBC drivers, Node.js, C and
C++ build wrappers and dependency analysis, and tuning such as threads, memory
and timeouts.

Reports are matched by name, so a report from a tool Sonar adds later works
without a new release of the action. Settings named like a list (`…Paths`) are
checked entry by entry. This assumes the scanner reads them as lists, which is
true of every documented one.

When the build leaves a setting out, it warns with _The analysis of pull
requests leaves out these settings_. If the analysis needs one of them, pass it
with `build-arguments` in the Sonar workflow. That's your own configuration, so
it's trusted.

When the Sonar workflow drops a setting from the upload, it warns with _Dropped
settings a build never ships_. A normal build never produces one, so either the
upload was tampered with, or the two workflows run different versions of the
action.

## What stays off on the fork path

Two Sonar features run the project's own build tools. On the fork path those
tools are the pull request's code, and they would run next to the token, so the
Sonar workflow always turns both features off.

- **Dependency analysis** (SCA, part of Sonar's Advanced Security) runs `mvnw`,
  `gradlew` or `npm` to list dependencies. Fork pull requests get no dependency
  analysis. Pushes and pull requests from your repository are analysed directly
  and keep it. To check dependencies on fork pull requests, use GitHub's
  [dependency review action](https://github.com/actions/dependency-review-action),
  which runs on `pull_request` without secrets.
- **Build-system autoconfiguration**, in SonarQube Cloud's engine, can configure
  a project by running its `mvnw`.

Don't turn them back on with `build-arguments` in the Sonar workflow, for
example with `-Dsonar.sca.enabled=true`. That would run the pull request's build
tools with your token.

## What a fork can still influence

A fork controls its own pull request's code and build, and so its analysis. It
can fake coverage and test results, exclude files, ignore issues, or stop its
analysis from running, and nothing will show it. None of this affects other pull
requests or your branches. Treat a fork's Sonar result as information about the
pull request, not as a review of it.

## Hardening your setup

- Trigger the build on `pull_request`, never on `pull_request_target`.
- Don't build fork pull requests on self-hosted runners that also run the Sonar
  workflow. A fork's build can tamper with what it leaves on the runner,
  including the scanner the action caches and reuses. GitHub advises against
  self-hosted runners for public repositories in its
  [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners).
- Pin the action to a commit SHA.
- Give the Sonar job only the permissions shown in the
  [setup](../README.md#setup), and no secrets or steps the analysis doesn't
  need.
- Don't add caching to the Sonar job, and never give it write access to the
  cache with `cache-mode`. GitHub only lets `workflow_run` jobs read the default
  branch's cache, so nothing they handle can poison later builds.
- Use a dedicated Sonar token, as described in the [setup](../README.md#setup).
- Optionally, require approval to run workflows from all outside contributors
  (Settings → Actions → General). It adds a layer of protection, but the
  analysis is safe without it.

With `checkout: false`, CodeQL may flag your checkout step in the Sonar workflow
as `actions/untrusted-checkout`, which means pull request code checked out in a
privileged job. No step in that job runs the checked-out code, so you can
dismiss the alert for that reason. Make sure the steps you add keep it that way.

## Keeping up with the scanner

Sonar changes its scanner on its own schedule, and some changes matter here.
Dependency analysis, build-system autoconfiguration and the engine's analytics,
which run `dotnet` in the scanner's working directory, all arrived that way.

On every pull request and once a week, this project tests the scanner CLI it
pins together with the engines that SonarQube Cloud and the latest SonarQube
Community Build serve. The tests check that:

- settings files and lists read back exactly as the action checked them
- the engine builds the same module structure and gives every setting to the
  same module
- the engine classes that can start a process match a reviewed list

The analysis of the test fixtures also sets traps. Stand-in build tools on the
`PATH`, and the fixtures' wrappers and Gradle settings, fail the run if the
analysis ever starts them.

Older SonarQube Server versions and commercial editions aren't tested.

## v1

v1 runs Maven or Gradle on the pull request's checkout in the job that holds the
Sonar token, so a fork can run code with the token. It gets no fixes. Move to
v2.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
