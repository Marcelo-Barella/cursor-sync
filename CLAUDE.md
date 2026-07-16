# CLAUDE.md

# Cursor Sync

This document contains repository-specific instructions for AI assistants working on this project.

Always read this file before making changes.

---

# Project Overview

Cursor Sync is a VS Code/Cursor extension that synchronizes user-level Cursor settings and assets through private GitHub Gists.

The project prioritizes:

1. Reliability
2. Data integrity
3. User safety
4. Backwards compatibility
5. Cross-platform compatibility

This extension modifies real user files. Every change should be treated as potentially destructive.

---

# Development Commands

Use the project's existing scripts.

```bash
npm install
npm run build
npm run lint
npm test
npm run package
```

Always ensure:

* TypeScript compiles successfully.
* Lint passes.
* Existing tests continue to pass.

---

# Architecture

The extension is intentionally modular.

`extension.ts` should remain lightweight.

Its responsibilities are primarily:

* registering commands
* initializing services
* wiring modules together
* starting background components
* activating UI

Business logic belongs inside dedicated modules.

Avoid moving implementation into `extension.ts`.

---

# Design Principles

When adding features:

* extend existing systems instead of replacing them
* prefer small, focused changes
* keep modules loosely coupled
* preserve existing behavior unless explicitly changing it

Avoid large refactors unless requested.

---

# Sync Safety

The sync engine is the most critical part of the project.

Never introduce changes that could silently lose user data.

Always preserve:

* safe mode
* rollback behavior
* conflict detection
* checksum validation
* manifest compatibility

If a feature could overwrite local files, require confirmation unless existing behavior explicitly says otherwise.

---

# Backwards Compatibility

Assume users already have:

* existing private Gists
* previous sync manifests
* older exported bundles
* previous transcript formats

New features should not break existing users whenever possible.

If a migration is required:

* make it explicit
* keep it one-way only if unavoidable
* preserve old data

---

# GitHub Integration

GitHub Personal Access Tokens are security-sensitive.

Never:

* print tokens
* log tokens
* expose tokens in exceptions
* write tokens into settings.json
* include tokens in telemetry

Tokens should remain inside VS Code SecretStorage.

---

# Chat Import & Export

Chat persistence should preserve fidelity.

Never intentionally modify transcript contents during export/import.

When changing chat import logic:

* preserve schema compatibility
* preserve metadata
* preserve checksums
* avoid altering conversation history

When possible, prefer additive schema evolution.

---

# File Operations

Always assume users are running:

* Windows
* macOS
* Linux

Do not assume:

* identical filesystem layouts
* case-sensitive paths
* identical home directories

Always use platform-safe path handling.

---

# Performance

Avoid unnecessary work.

Prefer:

* incremental updates
* cached state
* checksum comparisons
* targeted filesystem access

Avoid:

* rescanning everything repeatedly
* unnecessary GitHub API calls
* blocking the extension host

---

# Error Handling

Never silently ignore failures.

Instead:

* fail safely
* preserve existing user data
* provide actionable error messages
* leave the extension in a recoverable state

Unexpected errors should never leave partially written data without cleanup.

---

# Logging

Logs should help diagnose problems.

Do not log:

* GitHub tokens
* passwords
* private conversation contents
* sensitive filesystem data

Logs should describe what happened, not expose user information.

---

# Configuration

Whenever adding a new setting:

Update:

* package.json
* documentation
* default value
* validation
* migration logic if necessary

Do not add undocumented configuration options.

---

# Commands

Every new command should:

* use the existing command naming conventions
* be registered in package.json
* be registered in extension.ts
* have a clear title
* follow existing UX patterns

---

# UI

The sidebar, status bar, and command palette should remain consistent.

Prefer extending existing UI over introducing new views.

Avoid unnecessary notifications.

Only interrupt the user when action is required.

---

# Code Style

Prefer:

* async/await
* early returns
* descriptive names
* immutable data when practical
* reusable helper functions

Avoid:

* deeply nested conditionals
* duplicated logic
* unnecessary abstractions
* large functions

Comments should explain **why**, not **what**.

---

# Dependencies

Before adding a dependency:

Ask:

* Can the standard library do this?
* Can existing utilities do this?

Avoid increasing project complexity unnecessarily.

---

# Documentation

If behavior changes:

Update the README.

If configuration changes:

Update the README.

If commands change:

Update package.json and the README.

Documentation should stay synchronized with implementation.

---

# Testing

When modifying:

## Sync

Verify:

* push
* pull
* sync now
* conflict detection
* rollback
* safe mode

## Chat Import

Verify:

* export
* import
* bundle restore
* transcript restore
* activation flow

## Settings

Verify:

* defaults
* upgrades
* validation
* backward compatibility

---

# Before Finishing

Before considering work complete:

* Build succeeds.
* Lint succeeds.
* Tests pass.
* No unnecessary files changed.
* Documentation updated if needed.
* Existing behavior preserved.

---

# Things Never To Do

Never:

* commit secrets
* expose PATs
* bypass safe mode
* remove rollback protection
* weaken conflict detection
* silently overwrite user files
* introduce breaking configuration changes
* modify unrelated code
* perform large formatting-only changes

---

# AI Workflow

Before editing:

1. Read the surrounding implementation.
2. Understand why it exists.
3. Follow existing patterns.

While editing:

* keep changes minimal
* reuse existing utilities
* avoid speculative refactors

After editing:

* verify affected workflows
* check for unintended regressions
* ensure new code matches existing style

When requirements are ambiguous, ask instead of guessing.

---

# Goal

Leave the repository:

* safer
* simpler
* more maintainable
* more consistent

Every change should improve the project without compromising reliability or user trust.
