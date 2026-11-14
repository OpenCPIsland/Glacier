#!/usr/bin/env bash
# Runs every admin panel test; stops at the first failure.
set -u
cd "$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)"
for t in admin-panel/tests/*-test.ts; do
  if timeout 300 bun "$t" > /tmp/admin-test.log 2>&1; then echo "ok    $t"
  else echo "FAIL  $t"; grep -E "^FAIL" /tmp/admin-test.log | head; tail -5 /tmp/admin-test.log; exit 1; fi
done
