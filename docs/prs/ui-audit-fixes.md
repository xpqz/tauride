# Focused session menus and agent confirmation cancellation

The native macOS application menu belongs to the whole process. Previously,
Allow Control and Show Trace/Edit Toolbar ran the callback from the session
that most recently installed that menu, even when another session or its
floating tracer had focus. Observe Session shared the same routing defect.

These commands now carry semantic IDs and are delivered only to the focused
session/editor webview. They toggle that window's current preference; existing
floating-window IPC propagates it to the owning session. Preferences and About
ignore these commands and restore the native checkbox state. Existing clear
history and diagnostic menu routes retain their behavior.

An action waiting for agent confirmation could also survive disconnect or
control revocation, then run after reconnect or regrant. Pending confirmation
and IDE-readiness waits now cancel immediately, including the toast and timer.
Request identity protects the control slot, and connection identity prevents
late replies from reaching a replacement client with a reused request ID.
Revocation leaves already-dispatched interpreter work running.

## Validation

- Failing regressions were committed before implementation, following independent
  tests-only review. The original native implementation failed all six new cases.
- The integrated native regression run passed all 16 confirmation, menu ownership,
  toolbar and clear-history cases, including mounted floating tracer text/native
  focus and real native checkbox state.
- Agent core tests cover reused IDs, old Run/Deny/rejected confirmations, the
  60-second deadline with a fake clock, cancellation before toast creation,
  confirmation-disabled settling, asynchronous replies, callback failures and
  already-dispatched execution.
- Independent implementation review approved both changes after correcting
  signal forwarding and exception cleanup.

Full-suite, physical UI and CI results are recorded in the pull request.
