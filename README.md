# mend

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iwanr94/hidden-spec-cli/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iwanr94/hidden-spec-cli/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads a patch in one of four
formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
each edit names at the first of three matching tiers, and writes every change or
none, printing what it changed or why it failed. `SPEC.md` is the whole
specification.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When
  `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) and
`ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n> edits`,
and no file is written. Exit 2 prints one `error:` line (usage, no-patch,
format, or `parse <N>`).

## Matching

An edit's old lines are found at the first of three tiers at which they occur
at least once: tier 0 (every line equal), tier 1 (trailing spaces and tabs
ignored), tier 2 (leading and trailing spaces and tabs ignored). Context lines
are written as the file's own matched lines; at tier 2, added lines are
re-indented to the file's indentation. `--strict` tries tier 0 only.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what main.ts
  did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (practice score 1000): unified 30/30,
search-replace 20/20, v4a 20/20, json 15/15, cli 15/15.
