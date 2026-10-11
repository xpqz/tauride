# Preferences Select All follow-up

An isolated-profile macOS check on 11 October 2026 found that Cmd+A in Preferences → Title selected the main session transcript rather than the focused Title input. Typing the replacement title then appended to the input instead of replacing its text.

To reproduce, open Preferences, focus Title, press Cmd+A, and type replacement text. The exact regression origin has not been determined. This validation branch does not change Preferences or menu routing.
