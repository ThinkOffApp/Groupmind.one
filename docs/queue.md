# Your queue: three buttons

`/github` is everything waiting on you - open pull requests and pending agent
approvals - as **one queue, one item at a time, three buttons.**

It was built for a three-button desk gadget that presents as a Bluetooth
keyboard, so the whole queue is driveable with three keys and nothing else.
Any programmable keyboard, macro pad or assistive switch that can send a
character can drive it.

## The three buttons

Map your buttons to these keys. Send the bare character, with no modifiers.

| Button | Key | What it does |
| --- | --- | --- |
| 1 | `y` | yes, on the item showing |
| 2 | `n` | no, on the item showing |
| 3 | `m` | cycle to the next item without answering |

There is no configuration UI and none is needed: your side decides what your
buttons emit, and this is the table to emit.

**There is no defer button. You defer by cycling past.** Button 3 moves to the
next item and the one you skipped comes back round. Nothing is decided until
you press 1 or 2.

## Cycling changes what yes and no MEAN

Button 3 selects the target, and the target defines the verb:

| Item | `y` means | `n` means |
| --- | --- | --- |
| Pull request | **Merge** it into its base branch on GitHub | **Leave it** - it is not closed, not rejected, no review is left, and nothing at all is written to GitHub |
| Approval | **Approve** the action, so the agent runs it | **Deny** it, so the agent does not run it |

Because the verb changes with the item, **the card always states in a full
sentence what yes will do before you press it.** That sentence is the safety
property of this screen: a person who has cycled twice and looked away has to
be able to glance back and know what they are about to authorise.

The sentences live in one table, `VERBS` in `src/lib/queue-items.ts`. Adding a
kind means adding a row there plus a block in
`src/app/api/v1/queue/route.ts`. Nothing else in the queue knows what a pull
request is.

## Nothing commits on one press

Anything that writes somewhere else asks a second time, and the second ask is
**bound to that exact item and version** - the head commit for a pull request,
the last-write time for an approval.

- `y` opens a confirmation carrying the item, the verb and the fingerprint.
- A **fresh** `y` commits: two separate key-downs with the key released
  between them, and the first 400 ms ignored.
- If anything moves between the two presses - you cycle, the queue reloads, an
  agent revises its request, a branch receives a commit - the confirmation is
  cancelled and the second press does **nothing at all**. It never lands on a
  different item.
- A held or bouncing button cannot carry a decision from one item to the next:
  every transition re-arms the gate, and only a real key release clears it.
- Keys typed into an input, textarea or contenteditable belong to that field,
  so typing "yes" in a comment box approves nothing.
- A key and a click run the same reducer and hit the same session-gated route.
  Hardware input grants no permission a pointer does not have.

`n` on a pull request is the one action that writes nothing anywhere, so it
goes straight through. `n` on an approval records a denial, so it is confirmed
exactly like `y`.

## On a normal keyboard

The three-key path is added, not substituted. A laptop keeps:

| Key | Does |
| --- | --- |
| `Enter`, `→` | same as `y` |
| `Escape`, `←` | same as `n` (in a confirmation, backs out) |
| `↓` | same as `m` |
| `r` | reload the queue |

Every one of these also has an on-screen button, so the page is fully usable
by mouse and by touch.

## What is in the queue

- **Pull requests** - open PRs in the repositories your connected GitHub
  account can reach. Needs the GitHub connection below.
- **Approvals** - rows in the existing `action_status` table with status
  `pending`, scoped to you. These are what agents push through
  `/api/v1/actions`; this page is a second way to answer them, writing back
  through the same `upsert_action_status` function, so the monotonic guard in
  SQL applies to a decision made here exactly as to one pushed by an agent.

## Setting up pull requests

Approvals need no extra configuration. For pull requests, register a
[GitHub App](https://github.com/settings/apps/new) with **device flow
enabled** and give it, at minimum:

- **Pull requests: Read and write** - to list PRs and call the merge endpoint
- **Contents: Read and write** - a merge writes a commit to the base branch
- **Metadata: Read-only** - required by GitHub alongside the above

Then set one environment variable:

```bash
GITHUB_DEVICE_CLIENT_ID=Iv23li...
```

There is **no client secret and no callback URL.** That is why this uses
device flow rather than a redirect-based OAuth app: a redirect URL is
per-deployment configuration that every self-hoster has to get exactly right,
and device flow needs none. The client id is a public identifier and is safe
to put in your deployment config.

If you would rather register a classic **OAuth App**, it has no permissions of
its own, so name a scope as well:

```bash
GITHUB_DEVICE_SCOPE=public_repo     # or `repo` if you need private repos
```

Leave `GITHUB_DEVICE_SCOPE` unset for a GitHub App - that is the
least-privilege option, and the default.

## Where the token lives

The GitHub access token is stored in an **httpOnly, Secure, SameSite=Lax**
cookie bound to the signed-in user. It is never readable by page JavaScript,
never placed in a URL, and never returned by any endpoint. Nothing in the
GitHub modules logs, and the shared HTTP error path reports a status code
without ever echoing a response body.

The cookie carries the user id as well as the token, because browsers are
shared: without it, one person could connect GitHub, sign out, and leave the
next person signed in on that browser able to merge their repositories.
