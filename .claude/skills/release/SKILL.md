# Release

Orchestrate the Metadator release process.

## Steps

1. Ask for the new version (or accept as argument)
2. Update version in package.json
3. Run `bun run version` to sync manifest.json and versions.json
4. Run `bun run validate` to confirm everything passes
5. Run `bun test` to confirm tests pass
6. Stage and commit: `chore: bump version to X.Y.Z`
7. Create git tag: `X.Y.Z`
8. **Stop and confirm** before pushing — remind user that push triggers GitHub Actions release

## Rules

- Never push without explicit approval
- Abort if validate or tests fail
- Use semantic versioning
