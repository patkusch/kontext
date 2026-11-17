# Adding to kontext

Small, focused changes are welcome. Open an issue first for anything large, so nobody builds what will not be merged.

## Before you push

```bash
npm ci
npm run build
npm test
node dist/cli.js check --fail-on stale,orphaned
```

Push only when all of it passes. Never pipe the test output into something that hides a failure.

## What every change comes with

- A test that fails without the change and passes with it.
- The last command runs kontext on its own notes. If you change the code a note describes, update the note in the same change.
- Plain English in anything a person reads: say what it does and why, and put the plain meaning next to every number.
- No invented figures. A number in the README comes from a run you can repeat, and a result that showed no benefit still goes in.
