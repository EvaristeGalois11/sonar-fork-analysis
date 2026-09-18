#!/usr/bin/env python3
"""Helpers for the local end-to-end script.

Prototype of the logic the v2 action will implement in TypeScript: read the properties file the
Sonar Maven/Gradle plugin writes in simulation mode, keep only analysis settings, list the files
that have to travel to the analysis side, and rewrite paths that pointed into the build machine's
home directory.
"""

import argparse
import os
import sys

# Settings the analysis side always provides itself; never taken from the (untrusted) dump.
DENIED = (
    "sonar.host.url",
    "sonar.token",
    "sonar.login",
    "sonar.password",
    "sonar.organization",
    "sonar.projectKey",
    "sonar.region",
    "sonar.scanner.",
    "sonar.working.directory",
    "sonar.branch.",
    "sonar.pullrequest.",
    "sonar.scm.",
)

# Keys whose value is a comma separated list of paths.
PATH_KEYS = (
    "sonar.binaries",
    "sonar.libraries",
    "sonar.java.binaries",
    "sonar.java.libraries",
    "sonar.java.test.binaries",
    "sonar.java.test.libraries",
    "sonar.groovy.binaries",
    "sonar.junit.reportPaths",
    "sonar.junit.reportsPath",
    "sonar.surefire.reportsPath",
    "sonar.jacoco.reportPath",
    "sonar.jacoco.reportPaths",
    "sonar.coverage.jacoco.xmlReportPaths",
)

# Report locations sensors look for on their own. They are not in the dump, but they still have to
# be shipped, relative to each module's base directory.
IMPLICIT_REPORTS = (
    "target/site/jacoco/jacoco.xml",
    "target/site/jacoco-it/jacoco.xml",
    "build/reports/jacoco/test/jacocoTestReport.xml",
)


def read(path):
    """Read a java.util.Properties file as written by Properties.store()."""
    props = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line or line.lstrip().startswith("#"):
                continue
            key, index, escaped = [], 0, False
            while index < len(line):
                char = line[index]
                if escaped:
                    key.append(char)
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char in "=:":
                    break
                else:
                    key.append(char)
                index += 1
            value = line[index + 1:]
            value = value.replace("\\:", ":").replace("\\=", "=").replace("\\\\", "\\")
            props["".join(key)] = value
    return props


def write(props, path):
    with open(path, "w", encoding="utf-8") as handle:
        for key in sorted(props):
            escaped_key = key.replace("\\", "\\\\").replace(":", "\\:").replace("=", "\\=")
            handle.write(escaped_key + "=" + props[key].replace("\\", "\\\\") + "\n")


def module_prefixes(props, prefix=""):
    """Yield every module prefix, following nested modules. Module ids may contain dots."""
    yield prefix
    for module in [m for m in props.get(prefix + "sonar.modules", "").split(",") if m]:
        yield from module_prefixes(props, prefix + module + ".")


def bare_key(key, prefixes):
    for prefix in prefixes:
        if prefix and key.startswith(prefix):
            return key[len(prefix):]
    return key


def cmd_filter(args):
    props = read(args.source)
    prefixes = sorted(module_prefixes(props), key=len, reverse=True)
    kept = {}
    for key, value in props.items():
        bare = bare_key(key, prefixes)
        if bare.startswith("sonar.") and not bare.startswith(DENIED):
            kept[key] = value
    write(kept, args.target)
    print(f"kept {len(kept)} of {len(props)} properties", file=sys.stderr)


def collect(props, workspace, home):
    """Return (paths inside the workspace, paths inside the home dir), as relative paths."""
    prefixes = sorted(module_prefixes(props), key=len, reverse=True)
    candidates = set()
    for key, value in props.items():
        if bare_key(key, prefixes) in PATH_KEYS:
            candidates.update(entry for entry in value.split(",") if entry)
    for prefix in module_prefixes(props):
        base = props.get(prefix + "sonar.projectBaseDir")
        if base:
            candidates.update(os.path.join(base, report) for report in IMPLICIT_REPORTS)
    in_workspace, in_home = set(), set()
    for path in candidates:
        if not os.path.exists(path):
            continue
        if path.startswith(workspace + os.sep):
            in_workspace.add(os.path.relpath(path, workspace))
        elif path.startswith(home + os.sep):
            in_home.add(os.path.relpath(path, home))
    return sorted(in_workspace), sorted(in_home)


def cmd_paths(args):
    props = read(args.source)
    in_workspace, in_home = collect(props, args.workspace.rstrip("/"), args.home.rstrip("/"))
    with open(args.workspace_list, "w", encoding="utf-8") as handle:
        handle.write("\n".join(in_workspace) + "\n" if in_workspace else "")
    with open(args.home_list, "w", encoding="utf-8") as handle:
        handle.write("\n".join(in_home) + "\n" if in_home else "")
    print(f"{len(in_workspace)} workspace paths, {len(in_home)} home paths", file=sys.stderr)


def cmd_rewrite(args):
    """Point values at the analysis machine: workspace paths keep their place, home paths move."""
    props = read(args.source)
    old_workspace = args.old_workspace.rstrip("/")
    old_home = args.old_home.rstrip("/")
    rewritten = {}
    for key, value in props.items():
        parts = []
        for part in value.split(","):
            if part == old_workspace or part.startswith(old_workspace + os.sep):
                part = args.workspace.rstrip("/") + part[len(old_workspace):]
            elif part.startswith(old_home + os.sep):
                part = os.path.join(args.private_home, os.path.relpath(part, old_home))
            parts.append(part)
        rewritten[key] = ",".join(parts)
    write(rewritten, args.target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(required=True)

    filter_cmd = sub.add_parser("filter", help="keep only analysis settings")
    filter_cmd.add_argument("source")
    filter_cmd.add_argument("target")
    filter_cmd.set_defaults(func=cmd_filter)

    paths_cmd = sub.add_parser("paths", help="list files that have to be shipped")
    paths_cmd.add_argument("source")
    paths_cmd.add_argument("--workspace", required=True)
    paths_cmd.add_argument("--home", required=True)
    paths_cmd.add_argument("--workspace-list", required=True)
    paths_cmd.add_argument("--home-list", required=True)
    paths_cmd.set_defaults(func=cmd_paths)

    rewrite_cmd = sub.add_parser("rewrite", help="rewrite paths for the analysis machine")
    rewrite_cmd.add_argument("source")
    rewrite_cmd.add_argument("target")
    rewrite_cmd.add_argument("--old-workspace", required=True)
    rewrite_cmd.add_argument("--workspace", required=True)
    rewrite_cmd.add_argument("--old-home", required=True)
    rewrite_cmd.add_argument("--private-home", required=True)
    rewrite_cmd.set_defaults(func=cmd_rewrite)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
