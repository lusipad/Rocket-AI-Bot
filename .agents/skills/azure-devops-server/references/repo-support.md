# Repository Support

## Use This File For

- repository and branch reads on Azure DevOps Server
- pull request read routes
- directory listing and file content reads through the generic wrapper
- understanding what this skill supports vs the Azure DevOps Services MCP

## Scope And Boundary

This skill supports the Azure DevOps Server `git` area through `Invoke-AzureDevOpsServerApi.ps1`. It is a PowerShell-wrapper workflow, not a full clone of the Azure DevOps Services MCP.

Use it for:

- listing repositories in a project
- reading repository metadata
- listing branch refs when needed to inspect server state
- listing and reading pull requests
- listing directories and reading file content from `main`, or from a referenced branch/commit for review, when the repository has at least one branch or commit

Do not use repository mutation routes in RocketBot's current workflow. Do not modify code, create branches, commit, push, or create/update pull requests. If the user asks for those actions, read the relevant content and provide a suggested patch or implementation plan.

Do not claim Azure DevOps Services parity. This skill does not try to mirror every cloud-only repo tool, comment-thread helper, reviewer flow, or identity convenience flow from the official MCP.

## Validated Local Shape

These routes were validated locally against:

- collection: `http://localhost:8081/DefaultCollection`
- project: `test`
- repository: `test`
- branch: `main`

Reusable rule:

- replace `http://localhost:8081/DefaultCollection` with your collection URL
- replace `test` with your project and repository names or IDs
- prefer repository IDs when names are ambiguous
- default file and directory reads to `main`; for review URLs, preserve the referenced branch or commit

## Supported Read Routes

### List Repositories In A Project

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories
```

### Read One Repository

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test
```

### List Branches

Branch reads use `refs` with a `heads/` filter:

```powershell
$query = @{
  filter = "heads/"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/refs `
  -Query $query
```

### List Pull Requests

```powershell
$query = @{
  "searchCriteria.status" = "active"
  '$top' = 20
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/pullrequests `
  -Query $query
```

To read a single PR, switch to:

- `repositories/{repoIdOrName}/pullrequests/{pullRequestId}`

## Repository Mutations Are Out Of Scope

The generic REST wrapper can technically send write-gated `git` requests, but RocketBot's current Azure DevOps Server workflow must not expose or execute repository mutations.

Do not perform:

- branch creation or ref updates
- file edits through REST
- commits or pushes
- pull request creation or updates
- pull request reviewer/comment-thread mutation flows

When asked for repo changes, read the relevant `main` files and respond with analysis, a suggested patch, or clear implementation steps.

## Directory Listing And File Content Reads

Use the `items` route for repository browsing and file reads. On Azure DevOps Server, these calls depend on an existing branch or commit. On the local server, `items` works against `main` even though the repository detail payload still reports `size = 0`, so do not rely on `size` alone to decide whether content reads are possible.

### List A Directory

```powershell
$query = @{
  scopePath = "/"
  recursionLevel = "OneLevel"
  includeContentMetadata = "true"
  "versionDescriptor.version" = "main"
  "versionDescriptor.versionType" = "branch"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/items `
  -Query $query
```

### Read File Content

```powershell
$query = @{
  path = "/README.md"
  includeContent = "true"
  "versionDescriptor.version" = "main"
  "versionDescriptor.versionType" = "branch"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/items `
  -Query $query
```

If `items` returns `404` or `400` on Server, check:

- the repository has at least one real branch or commit
- the branch or commit exists
- the path is correct
- the route is project-scoped and uses the expected `git` area

## Practical Boundary Vs Azure DevOps Services MCP

The official Azure DevOps MCP exposes a broader repositories surface, including richer pull-request thread and reviewer helpers. This server skill intentionally keeps repository support narrower:

- use the generic REST wrapper instead of a large tool catalog
- keep RocketBot repository flows read-only and scoped to `main`
- report unsupported or server-specific gaps instead of inventing cloud behavior
