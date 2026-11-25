---
name: project-check-in
description: Use when the user asks for a project check-in, project update, or dated project-status note covering the goal, where progress is measured, what remains, and how to measure the remainder.
---

# Project check-in

Ask and answer these four questions, in this order, from the available project
context:

> Now tell me, what is the goal?
>
> Then tell me, where do we measure against that goal?
>
> Then tell me, what remains against the goal?
>
> Then tell me how to measure what remains.

Use four matching sections. Name the actual measurement sources and distinguish
verified results from plans, unknowns and untested work. Do not invent the
project goal, a baseline, progress, completion, or test results. If a fact is not
supported by available evidence, label it unknown or unverified.

Inspect only the context and project material needed for the check-in. Follow
the project's `AGENTS.md` and all native permissions. A check-in is a reporting
task, not authorization to run tests, builds, project commands, application
code, deployments, or other work. Do not run those as part of the check-in. If
the user separately asks for such work, treat it as a separate request and
follow its scope and native permissions. Do not start `/goal`, delegate to a
subagent, or change task, issue, or reminder state. Use existing test results;
if a measurement needs a command or test that has not been run, say so and
explain how to measure it instead of running it.

Save each run as a new timestamped Markdown check-in using the user's local
date and time, for example `YYYY-MM-DD-HHMMSS-project-check-in.md`. Use the
destination the user specifies or the project's established documentation
location; do not prescribe a directory. If the project, destination, or local
time zone cannot be determined without guessing, ask before saving. Confirm the
target path does not already exist before creating a new file. If the name
already exists, including two runs within one second, add a numeric suffix and
check that path too. Never overwrite, truncate, or purge an earlier check-in.

If requested, append a new timestamped section to an existing Markdown file
instead of creating a separate file. Give each section a unique timestamped
heading, adding a suffix if needed. Preserve all earlier check-ins and unrelated
content; inspect the existing file before editing it.

In Plan, read-only, or permission-denied contexts, do not try another tool,
agent, path, or method to get around the restriction. Provide the four-section
check-in in the conversation when possible, say clearly that it was not saved,
and explain the restriction. If the requested destination cannot be safely
preserved, do not write; explain the issue and ask how to proceed.

Report the exact saved path and, for an embedded check-in, its section. Never
claim a file was saved unless the write succeeded and the resulting content was
verified.
