#!/usr/bin/env bash
#
# Local end-to-end check for one fixture.
#
# Analyses a fixture twice against a throwaway SonarQube and compares the results:
#
#   baseline  the way Sonar intends it: the build tool's Sonar plugin talks to the server itself
#   split     the way this action works: build and dump the settings without a server, hand the
#             settings and the build output over, then analyse with the scanner CLI
#
# Any difference in measures, issues or analysed files fails the script. The GitHub workflow is the
# authoritative test; this exists to check a change before pushing.
#
# Usage: scripts/e2e.sh [maven|gradle] ...
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/sonar-fork-analysis"
CONTAINER_NAME="${CONTAINER_NAME:-sonar-fork-analysis-e2e}"
SONARQUBE_IMAGE="${SONARQUBE_IMAGE:-docker.io/library/sonarqube:community}"
SONAR_URL="${SONAR_URL:-http://localhost:9000}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Local-e2e-Pass1!}"
SCANNER_VERSION="${SCANNER_VERSION:-8.1.0.6389}"
SCANNER_SHA256="ab76ab3c360025e9108be5b55be066f304a164f8b2850d2f2f333915db51bc1b"
MAVEN_PLUGIN_VERSION="${MAVEN_PLUGIN_VERSION:-5.8.0.7211}"
# Any port that refuses connections: proves the build never reaches a server while dumping.
OFFLINE_URL="http://127.0.0.1:9"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

container_engine() {
  if command -v podman >/dev/null 2>&1; then echo podman
  elif command -v docker >/dev/null 2>&1; then echo docker
  else fail "neither podman nor docker found"
  fi
}

api() { # api <method> <path> [curl args...]
  local method="$1" path="$2"; shift 2
  curl -sS -u "admin:${ADMIN_PASSWORD}" -X "$method" "${SONAR_URL}${path}" "$@"
}

start_sonarqube() {
  local engine; engine="$(container_engine)"
  if ! "$engine" ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    if "$engine" ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
      log "Starting existing container $CONTAINER_NAME"
      "$engine" start "$CONTAINER_NAME" >/dev/null
    else
      log "Starting $SONARQUBE_IMAGE as $CONTAINER_NAME"
      "$engine" run -d --name "$CONTAINER_NAME" -p 9000:9000 "$SONARQUBE_IMAGE" >/dev/null
    fi
  fi
  log "Waiting for SonarQube to be up"
  for _ in $(seq 1 120); do
    if curl -sf "${SONAR_URL}/api/system/status" | grep -q '"UP"'; then return; fi
    sleep 5
  done
  fail "SonarQube did not come up; see: $(container_engine) logs $CONTAINER_NAME"
}

sonar_token() {
  # First run: the initial password must be changed before the API can be used.
  curl -sS -u "admin:admin" -X POST "${SONAR_URL}/api/users/change_password" \
    --data-urlencode "login=admin" --data-urlencode "previousPassword=admin" \
    --data-urlencode "password=${ADMIN_PASSWORD}" >/dev/null 2>&1 || true
  api POST "/api/user_tokens/revoke" -d "name=e2e" >/dev/null 2>&1 || true
  api POST "/api/user_tokens/generate" -d "name=e2e" -d "type=GLOBAL_ANALYSIS_TOKEN" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
}

scanner_cli() {
  local dir="${CACHE_DIR}/sonar-scanner-${SCANNER_VERSION}"
  if [[ ! -x "${dir}/bin/sonar-scanner" ]]; then
    mkdir -p "$CACHE_DIR"
    local zip="${CACHE_DIR}/sonar-scanner-cli-${SCANNER_VERSION}.zip"
    curl -sSL -o "$zip" \
      "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SCANNER_VERSION}.zip"
    echo "${SCANNER_SHA256}  ${zip}" | sha256sum -c - >/dev/null || fail "scanner checksum mismatch"
    python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$CACHE_DIR"
    chmod +x "${dir}/bin/sonar-scanner"
  fi
  echo "${dir}/bin/sonar-scanner"
}

# Runs the fixture's build together with the Sonar plugin.
#   build_and_analyse <fixture> <dir> <extra plugin args...>
build_and_analyse() {
  local fixture="$1" dir="$2"; shift 2
  case "$fixture" in
    maven)
      (cd "$dir" && ./mvnw -B -e verify \
        "org.sonarsource.scanner.maven:sonar-maven-plugin:${MAVEN_PLUGIN_VERSION}:sonar" "$@")
      ;;
    gradle)
      (cd "$dir" && ./gradlew --no-daemon check sonar "$@")
      ;;
    *) fail "unknown fixture: $fixture" ;;
  esac
}

# Copies a fixture the way a checkout would look: sources only, no build output.
copy_fixture() { # <source> <target>
  local source="$1" target="$2"
  cp -r "$source" "$target"
  find "$target" -mindepth 1 \( -name target -o -name build -o -name .gradle \) -type d \
    -prune -exec rm -rf {} +
}

analyse_baseline() { # <fixture> <dir> <project key> <token>
  local fixture="$1" dir="$2" key="$3" token="$4"
  log "[$fixture] baseline: build tool plugin talks to the server"
  build_and_analyse "$fixture" "$dir" \
    "-Dsonar.host.url=${SONAR_URL}" "-Dsonar.projectKey=${key}" "-Dsonar.token=${token}"
}

analyse_split() { # <fixture> <build dir> <analysis dir> <project key> <token> <work dir>
  local fixture="$1" build_dir="$2" analysis_dir="$3" key="$4" token="$5" work="$6"
  local dump="${work}/dump.properties" settings="${work}/sonar.properties"
  local private_home="${work}/private-home"

  log "[$fixture] split, step 1: build and dump the settings with no server"
  build_and_analyse "$fixture" "$build_dir" \
    "-Dsonar.host.url=${OFFLINE_URL}" \
    "-Dsonar.scanner.dumpToFile=${dump}" \
    "-Dsonar.scanner.internal.dumpToFile=${dump}"
  [[ -f "$dump" ]] || fail "no dump produced: the plugin ignored the dump property"

  log "[$fixture] split, step 2: keep only analysis settings and collect the files to ship"
  python3 "${REPO_ROOT}/scripts/lib/dump.py" filter "$dump" "$settings"
  if [[ -n "${BREAK_LIBRARIES:-}" ]]; then
    # Self-check: dropping the libraries has to make the comparison fail. Analysis then silently
    # loses the issues that need resolved types, which is the regression this script exists for.
    log "[$fixture] BREAK_LIBRARIES set: removing library settings on purpose"
    grep -v "libraries=" "$settings" > "${settings}.broken" && mv "${settings}.broken" "$settings"
  fi
  python3 "${REPO_ROOT}/scripts/lib/dump.py" paths "$settings" \
    --workspace "$build_dir" --home "$HOME" \
    --workspace-list "${work}/workspace.list" --home-list "${work}/home.list"
  tar -cf "${work}/outputs.tar" -C "$build_dir" -T "${work}/workspace.list"
  tar -cf "${work}/libraries.tar" -C "$HOME" -T "${work}/home.list"

  log "[$fixture] split, step 3: unpack next to a fresh checkout and analyse"
  tar -xf "${work}/outputs.tar" -C "$analysis_dir"
  mkdir -p "$private_home"
  tar -xf "${work}/libraries.tar" -C "$private_home"
  python3 "${REPO_ROOT}/scripts/lib/dump.py" rewrite "$settings" "${work}/analysis.properties" \
    --old-workspace "$build_dir" --workspace "$analysis_dir" \
    --old-home "$HOME" --private-home "$private_home"
  (cd "$analysis_dir" && SONAR_TOKEN="$token" "$(scanner_cli)" \
    "-Dproject.settings=${work}/analysis.properties" \
    "-Dsonar.host.url=${SONAR_URL}" "-Dsonar.projectKey=${key}")
}

fetch_results() { # <project key> <output prefix>
  local key="$1" out="$2"
  local metrics="ncloc,files,classes,functions,complexity,coverage,line_coverage,branch_coverage"
  metrics="${metrics},lines_to_cover,uncovered_lines,tests,test_failures,skipped_tests"
  metrics="${metrics},duplicated_lines,bugs,vulnerabilities,code_smells,security_hotspots"
  api GET "/api/measures/component?component=${key}&metricKeys=${metrics}" \
    | python3 -c '
import json, sys
measures = json.load(sys.stdin)["component"]["measures"]
for measure in sorted(measures, key=lambda m: m["metric"]):
    print(measure["metric"], measure.get("value"))' > "${out}.measures"
  api GET "/api/issues/search?components=${key}&ps=500" \
    | python3 -c '
import json, sys
issues = json.load(sys.stdin)["issues"]
path = lambda issue: (issue["component"].split(":", 1) + [""])[1]
for issue in sorted(issues, key=lambda i: (path(i), i.get("line") or 0, i["rule"])):
    print(issue["rule"], path(issue), issue.get("line"), issue["message"])' > "${out}.issues"
  api GET "/api/measures/component_tree?component=${key}&qualifiers=FIL,UTS&metricKeys=coverage&ps=500" \
    | python3 -c '
import json, sys
for component in sorted(json.load(sys.stdin)["components"], key=lambda c: c["path"]):
    coverage = [m["value"] for m in component["measures"] if m["metric"] == "coverage"]
    print(component["qualifier"], component["path"], coverage)' > "${out}.files"
}

run_fixture() { # <fixture> <token>
  local fixture="$1" token="$2"
  local work; work="$(mktemp -d "${TMPDIR:-/tmp}/sfa-e2e-${fixture}-XXXXXX")"
  local source="${REPO_ROOT}/fixtures/${fixture}"

  # Start from empty projects: SonarQube keeps issues between analyses, so leftovers from an
  # earlier run would show up in the comparison.
  api POST "/api/projects/delete" -d "project=${fixture}-baseline" >/dev/null 2>&1 || true
  api POST "/api/projects/delete" -d "project=${fixture}-split" >/dev/null 2>&1 || true

  # Each run gets its own copy, so the fixture in the repository is never built in place.
  copy_fixture "$source" "${work}/baseline"
  copy_fixture "$source" "${work}/prepare"
  copy_fixture "$source" "${work}/checkout"  # stands in for the checkout of the pull request

  analyse_baseline "$fixture" "${work}/baseline" "${fixture}-baseline" "$token"
  analyse_split "$fixture" "${work}/prepare" "${work}/checkout" "${fixture}-split" "$token" "$work"

  log "[$fixture] waiting for the server to finish processing"
  for _ in $(seq 1 60); do
    local pending
    pending="$(api GET "/api/ce/activity_status" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["pending"]+d["inProgress"])')"
    [[ "$pending" == "0" ]] && break
    sleep 2
  done

  fetch_results "${fixture}-baseline" "${work}/baseline"
  fetch_results "${fixture}-split" "${work}/split"

  log "[$fixture] comparing"
  local failed=0
  for kind in measures issues files; do
    if diff -u "${work}/baseline.${kind}" "${work}/split.${kind}"; then
      echo "  $kind: identical"
    else
      echo "  $kind: DIFFERENT"
      failed=1
    fi
  done
  if [[ "$failed" != "0" ]]; then
    fail "[$fixture] split analysis does not match the baseline (kept in $work)"
  fi
  # Guard against both sides being equally broken.
  grep -q "java:S2699" "${work}/baseline.issues" \
    || fail "[$fixture] baseline lacks the JUnit-dependent issues; fixture or setup is broken"
  echo "[$fixture] OK"
  rm -rf "$work"
}

main() {
  local fixtures=("$@")
  [[ ${#fixtures[@]} -eq 0 ]] && fixtures=(maven gradle)
  start_sonarqube
  local token; token="$(sonar_token)"
  for fixture in "${fixtures[@]}"; do
    run_fixture "$fixture" "$token"
  done
  log "All fixtures matched their baseline"
}

main "$@"
