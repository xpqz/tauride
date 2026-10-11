# Preferences Select All follow-up

An isolated-profile macOS check on 11 October 2026 found that Cmd+A in Preferences → Title selected the main session transcript rather than the focused Title input. Typing the replacement title then appended to the input instead of replacing its text.

To reproduce, open Preferences, focus Title, press Cmd+A, and type replacement text. The cause, fix, and validation are documented in [Preferences Select All](preferences-select-all.md).
