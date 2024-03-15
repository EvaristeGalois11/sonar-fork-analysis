# Sonar Fork Analysis
The goal of this action is to open up the possibility of Sonar scanning external forks of your project.

## Usage

Add this action to your build workflow.
```yml
name: 'Build'
on:
  push:
    branches:
      - master
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  build:
    name: 'Build project'
    runs-on: ubuntu-latest
    steps:
      
      ...

      - name: 'Build'
        run: ./mvnw -B install # Be sure to invoke the install goal!

      - name: 'Prepare Sonar analysis'
        uses: evaristegalois11/sonar-fork-analysis@v1
```

Create a new workflow triggered by the conclusion of the previous one and add this action to it. 
```yml
name: 'Sonar'
on:
  workflow_run:
    workflows: [ Build ]
    types:
      - completed
jobs:
  sonar:
    name: 'Sonar analysis'
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    permissions:
      actions: read # Required to download artifacts
    steps:
      - name: 'Sonar analysis'
        uses: evaristegalois11/sonar-fork-analysis@v1
        with:
          distribution: your-java-distribution
          java-version: your-java-version
          github-token: ${{ secrets.GITHUB_TOKEN }}
          sonar-token: ${{ secrets.SONAR_TOKEN }}
          project-key: your-project-key
```

The first workflow will gather all the necessary files and upload them as an artifact. The second one will use the produced artifact to kick off the Sonar analysis.

## Parameters

- `java-version`:The Java version to set up. Takes a whole or semver Java version. See examples of supported syntax in [actions/setup-java README file](https://github.com/actions/setup-java?tab=readme-ov-file#usage).

- `distribution`:The Java distribution. See the list of supported distributions in [actions/setup-java README file](https://github.com/actions/setup-java?tab=readme-ov-file#usage).

- `github-token`:The GitHub token used to authenticate with the GitHub API.

- `sonar-token`:The Sonar token used to authenticate with the Sonar API.

- `project-key`:The project's unique key assigned by Sonar.

## Useful resources
https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions
https://community.sonarsource.com/t/sonar-cannot-be-run-on-pr-from-a-fork/69229
https://community.sonarsource.com/t/how-to-use-sonarcloud-with-a-forked-repository-on-github/7363