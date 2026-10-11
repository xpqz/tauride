# Preferences Select All

On macOS, Cmd+A or Edit → Select All in Preferences selected the main session editor instead of the focused Preferences field. Typing a replacement title then appended to the Title input. The application menu belonged to the session webview, and its Select All callback used that session's remembered editor even while Preferences had native focus.

The native menu now sends Select All directly to the focused Preferences webview. Its listener waits until the Tauri API is ready and selects the active text input or textarea. Scoping the listener to that webview prevents another session's Preferences window from responding. Main editor and About/Log routing remain unchanged.

Validation: the original menu and physical Cmd+A cases failed on the baseline. A two-session isolation test failed with an intentionally app-wide listener. With the scoped listener, all 9 focused native tests and 126 unit tests passed. JavaScript syntax, Rust parsing, and diff checks passed; independent review approved the change. The full native suite was not run for this change.

- Independent physical macOS check: Cmd+A replaced the Title value, Edit → Select All selected the full Menu text, and Cancel returned to the main session without a transcript selection.
